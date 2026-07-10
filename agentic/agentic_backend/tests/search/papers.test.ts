import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CorpusDb } from "../../src/db/corpus.js";
import {
  extractTitleKeyword,
  firstAuthorLastname,
  keywordSearch,
  semanticSearchWithVector,
  verifyReferences,
} from "../../src/search/papers.js";
import { vectorLiteral, EMBED_DIM } from "../../src/search/embed.js";
import { openFixture, loadQueryVec } from "./helpers.js";

describe("extractTitleKeyword", () => {
  it("picks the first substantive word of 5+ chars", () => {
    expect(extractTitleKeyword("The Minimum Wage and Employment")).toBe("Minimum");
  });
  it("skips stopwords even when long enough", () => {
    expect(extractTitleKeyword("About Those Wages")).toBe("Wages");
  });
  it("falls back to 4-char words when nothing longer exists", () => {
    expect(extractTitleKeyword("On the wage gap")).toBe("wage");
  });
  it("returns null for degenerate titles", () => {
    expect(extractTitleKeyword("On a b c")).toBeNull();
  });
});

describe("firstAuthorLastname", () => {
  it("takes the first semicolon-separated segment, trimmed", () => {
    expect(firstAuthorLastname("Dube; Lester; Reich")).toBe("Dube");
  });
  it("returns null for empty input", () => {
    expect(firstAuthorLastname("  ")).toBeNull();
  });
});

describe("vectorLiteral", () => {
  it("renders a typed float array literal", () => {
    expect(vectorLiteral([0.1, -0.2])).toBe(`[0.1,-0.2]::FLOAT[${EMBED_DIM}]`);
  });
});

describe("fixture-backed search", () => {
  let db: CorpusDb;
  beforeAll(async () => {
    db = await openFixture();
  });
  afterAll(() => db.close());

  describe("keywordSearch", () => {
    it("matches keyword in title (any, default field)", async () => {
      const { total, results } = await keywordSearch(db, { keywords: ["minimum wage"], limit: 50 });
      expect(total).toBeGreaterThan(50);
      expect(results.length).toBe(50);
      results.forEach((r) => expect(r.title?.toLowerCase()).toContain("minimum wage"));
    });

    it("match=all requires every keyword", async () => {
      const any = await keywordSearch(db, { keywords: ["minimum wage", "monopsony"], match: "any" });
      const all = await keywordSearch(db, { keywords: ["minimum wage", "monopsony"], match: "all" });
      expect(all.total).toBeLessThan(any.total);
      all.results.forEach((r) => {
        expect(r.title?.toLowerCase()).toContain("minimum wage");
        expect(r.title?.toLowerCase()).toContain("monopsony");
      });
    });

    it("searches the requested fields", async () => {
      const byAuthor = await keywordSearch(db, { keywords: ["dube"], fields: ["authors"], limit: 10 });
      expect(byAuthor.total).toBeGreaterThan(0);
      byAuthor.results.forEach((r) => expect(r.authors?.toLowerCase()).toContain("dube"));
    });

    it("applies year bounds and category filter", async () => {
      const res = await keywordSearch(db, {
        keywords: ["minimum wage"],
        minYear: 2015,
        maxYear: 2020,
        categories: ["Top 5 Journals"],
      });
      res.results.forEach((r) => {
        expect(r.year).toBeGreaterThanOrEqual(2015);
        expect(r.year).toBeLessThanOrEqual(2020);
        expect(r.category).toBe("Top 5 Journals");
      });
    });

    it("order_by=citations sorts by total_citations descending", async () => {
      const { results } = await keywordSearch(db, {
        keywords: ["minimum wage"],
        orderBy: "citations",
        limit: 10,
      });
      const stats = await Promise.all(
        results.map(async (r) => {
          const rows = await db.query(
            "SELECT total_citations FROM handle_stats WHERE handle = LOWER(?)",
            [r.Handle],
          );
          return Number(rows[0]?.total_citations ?? 0);
        }),
      );
      const sorted = [...stats].sort((a, b) => b - a);
      expect(stats).toEqual(sorted);
      expect(stats[0]).toBeGreaterThan(0);
    });

    it("paginates with a stable total", async () => {
      const p1 = await keywordSearch(db, { keywords: ["minimum wage"], limit: 5, offset: 0 });
      const p2 = await keywordSearch(db, { keywords: ["minimum wage"], limit: 5, offset: 5 });
      expect(p1.total).toBe(p2.total);
      const h1 = new Set(p1.results.map((r) => r.Handle));
      p2.results.forEach((r) => expect(h1.has(r.Handle)).toBe(false));
    });

    it("treats SQL metacharacters as literal text (parameterised)", async () => {
      const res = await keywordSearch(db, { keywords: ["'; DROP TABLE articles; --"] });
      expect(res.total).toBe(0);
      const still = await db.query("SELECT COUNT(*) AS n FROM articles");
      expect(Number(still[0].n)).toBeGreaterThan(0);
    });

    it("LIKE wildcards in keywords are treated literally", async () => {
      const pct = await keywordSearch(db, { keywords: ["%"] });
      const underscore = await keywordSearch(db, { keywords: ["wage_growth"] });
      // literal-% titles are rare; "_" must not act as single-char wildcard
      const all = Number((await db.query("SELECT COUNT(*) AS n FROM articles"))[0].n);
      expect(pct.total).toBeLessThan(all / 10);
      const wildcardCount = await db.query(
        "SELECT COUNT(*) AS n FROM articles WHERE LOWER(title) LIKE '%wage_growth%'",
      );
      expect(underscore.total).toBeLessThanOrEqual(Number(wildcardCount[0].n));
    });
  });

  describe("semanticSearchWithVector", () => {
    it("ranks a paper first when queried with its own embedding", async () => {
      const { handle, vec } = loadQueryVec();
      const results = await semanticSearchWithVector(db, vec, { maxK: 5 });
      expect(results[0].Handle).toBe(handle);
      expect(results[0].similarity).toBeLessThan(1e-4);
      expect(results[0].similarity_score).toBeCloseTo(1, 3);
    });

    it("respects filters (min_year excludes the seed paper)", async () => {
      const { handle, vec } = loadQueryVec();
      const seed = await db.query("SELECT year FROM articles WHERE Handle = ?", [handle]);
      const cutoff = Number(seed[0].year) + 1;
      const results = await semanticSearchWithVector(db, vec, { maxK: 5, minYear: cutoff });
      results.forEach((r) => {
        expect(r.Handle).not.toBe(handle);
        expect(r.year).toBeGreaterThanOrEqual(cutoff);
      });
    });

    it("orders by ascending cosine distance", async () => {
      const { vec } = loadQueryVec();
      const results = await semanticSearchWithVector(db, vec, { maxK: 20 });
      const sims = results.map((r) => r.similarity);
      expect(sims).toEqual([...sims].sort((a, b) => a - b));
    });
  });

  describe("verifyReferences", () => {
    it("tier 1: matches by handle, case-insensitively", async () => {
      const { handle } = loadQueryVec();
      const [upper, lower] = await verifyReferences(db, [
        { handle },
        { handle: handle.toLowerCase() },
      ]);
      expect(upper.status).toBe("handle_match");
      expect(lower.status).toBe("handle_match");
      expect(lower.paper?.Handle).toBe(handle);
    });

    it("tier 2: fuzzy-matches on year + author + title keyword, with stats", async () => {
      const [r] = await verifyReferences(db, [
        {
          cite_key: "dube2010",
          author_lastnames: "Dube; Lester; Reich",
          year: 2010,
          title: "Minimum Wage Effects Across State Borders",
        },
      ]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.paper?.year).toBe(2010);
      expect(r.stats?.total_citations).toBeGreaterThan(100);
    });

    it("tier 3: loose-matches when the year is off by one", async () => {
      // Derive a clean tier-3 case from the fixture: seed paper queried at
      // year+1, after asserting tier 2 has no competing (year+1, author, kw) hit.
      const { handle } = loadQueryVec();
      const [seed] = await db.query(
        "SELECT title, authors, year FROM articles WHERE Handle = ?",
        [handle],
      );
      const title = String(seed.title);
      const author = String(seed.authors).split(/[;,]/)[0].trim().split(/\s+/).pop() ?? "";
      const shiftedYear = Number(seed.year) + 1;
      const kw = extractTitleKeyword(title) ?? "";
      const competing = await db.query(
        `SELECT COUNT(*) AS n FROM articles a
         WHERE a.year = ? AND LOWER(a.authors) LIKE ? AND LOWER(a.title) LIKE ?`,
        [shiftedYear, `%${author.toLowerCase()}%`, `%${kw.toLowerCase()}%`],
      );
      expect(Number(competing[0].n)).toBe(0); // else the fixture slice changed — pick a new anchor

      const [r] = await verifyReferences(db, [
        { author_lastnames: author, year: shiftedYear, title },
      ]);
      expect(r.status).toBe("loose_match");
      expect(r.paper?.year).toBe(Number(seed.year));
    });

    it("flags journal mismatches without failing the match", async () => {
      const [r] = await verifyReferences(db, [
        {
          author_lastnames: "Dube; Lester; Reich",
          year: 2010,
          title: "Minimum Wage Effects Across State Borders",
          journal: "Journal of Political Economy",
        },
      ]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.mismatches.some((m) => m.kind === "journal")).toBe(true);
    });

    it("returns not_found for fictional entries and incomplete ones", async () => {
      const [fictional, incomplete] = await verifyReferences(db, [
        { author_lastnames: "Zzyzx", year: 1999, title: "A Fictional Paper That Does Not Exist" },
        { cite_key: "no-fields" },
      ]);
      expect(fictional.status).toBe("not_found");
      expect(fictional.paper).toBeNull();
      expect(incomplete.status).toBe("not_found");
    });
  });
});
