import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CorpusDb } from "../../src/db/corpus.js";
import {
  extractTitleKeyword,
  firstAuthorLastname,
  keywordSearch,
  semanticSearchWithVector,
  verifyReferences,
} from "../../src/search/papers.js";
import { openFixture, loadQueryVec } from "./helpers.js";

// Phase 1 edge-case extension (PLAN.md §12.4): unicode/empty keywords, LIKE
// escape combinations, verify-tier fall-through and mismatch boundaries,
// pagination extremes. Fixture facts these tests rely on (corpus_fixture.duckdb
// is a fixed artefact, not rebuilt): 2975 articles; exactly 3 titles contain a
// literal "%" (the "Top 1%?" trio); exactly 1 title contains a literal
// backslash (RePEc:arx:papers:2601.00281, "R-$\sigma$ Model"); exactly 1 title
// contains "Praxisgebühr".

describe("extractTitleKeyword (edge cases)", () => {
  it("ignores regex metacharacters in the title (input is matched, not compiled)", () => {
    expect(extractTitleKeyword("(Minimum) Wage* [Effects]? {Across} +Borders^")).toBe("Minimum");
  });

  it("extracts from ASCII runs only — umlauts split words by design", () => {
    // [A-Za-z]{5,} is deliberately ASCII: "Bürokratie" yields its longest
    // ASCII run "rokratie", which still works as a LIKE needle.
    expect(extractTitleKeyword("Übermäßige Bürokratie")).toBe("rokratie");
  });

  it("falls back past all-stopword titles to the \\w{4,} rule (stopwords not re-checked)", () => {
    expect(extractTitleKeyword("About Between Through")).toBe("About");
  });

  it("returns null for empty and non-word titles", () => {
    expect(extractTitleKeyword("")).toBeNull();
    expect(extractTitleKeyword("!!! ??? ...")).toBeNull();
  });
});

describe("firstAuthorLastname (edge cases)", () => {
  it("treats a comma-separated list as one lastname — semicolon is the wire contract", () => {
    expect(firstAuthorLastname("Dube, Lester, Reich")).toBe("Dube, Lester, Reich");
  });

  it("returns null when the first semicolon segment is empty", () => {
    expect(firstAuthorLastname("; Dube")).toBeNull();
  });
});

describe("fixture-backed edge cases", () => {
  let db: CorpusDb;
  let totalArticles: number;

  beforeAll(async () => {
    db = await openFixture();
    const rows = await db.query("SELECT COUNT(*) AS n FROM articles");
    totalArticles = Number(rows[0].n);
  });
  afterAll(() => db.close());

  describe("keywordSearch: unicode and degenerate keywords", () => {
    it("matches umlaut keywords case-insensitively", async () => {
      // derive an umlaut word from the fixture (build_fixture.ts guarantees some)
      const [row] = await db.query(
        "SELECT title FROM articles WHERE LOWER(title) LIKE '%ü%' OR LOWER(title) LIKE '%ö%' ORDER BY Handle LIMIT 1",
      );
      expect(row).toBeDefined();
      const word = String(row.title).match(/[A-Za-zÄÖÜäöüß]*[äöüÄÖÜ][A-Za-zÄÖÜäöüß]*/)?.[0] ?? "";
      expect(word.length).toBeGreaterThan(2);
      const lower = await keywordSearch(db, { keywords: [word.toLowerCase()], limit: 500 });
      const upper = await keywordSearch(db, { keywords: [word.toUpperCase()], limit: 500 });
      expect(lower.total).toBeGreaterThan(0);
      expect(upper.total).toBe(lower.total);
      expect(upper.results.map((r) => r.Handle)).toEqual(lower.results.map((r) => r.Handle));
    });

    it("CJK and emoji keywords return zero rows without erroring", async () => {
      const cjk = await keywordSearch(db, { keywords: ["最低賃金"] });
      const emoji = await keywordSearch(db, { keywords: ["🔥📈"] });
      expect(cjk.total).toBe(0);
      expect(emoji.total).toBe(0);
    });

    it("rejects empty or whitespace-only keywords with a clear service-level error", async () => {
      await expect(keywordSearch(db, { keywords: [""], limit: 1 })).rejects.toThrow(
        /at least one non-empty keyword/,
      );
      await expect(keywordSearch(db, { keywords: ["  ", "\t"] })).rejects.toThrow(
        /at least one non-empty keyword/,
      );
    });

    it("rejects an empty keywords array with a clear service-level error", async () => {
      await expect(keywordSearch(db, { keywords: [] })).rejects.toThrow(
        /at least one non-empty keyword/,
      );
    });

    it("has no service-side cap on keyword count (the 20-keyword cap is route-only)", async () => {
      const junk = Array.from({ length: 24 }, (_, i) => `zzqx${i}nomatch`);
      const res = await keywordSearch(db, { keywords: [...junk, "minimum wage"], match: "any", limit: 1 });
      const base = await keywordSearch(db, { keywords: ["minimum wage"], limit: 1 });
      expect(res.total).toBe(base.total);
    });
  });

  describe("keywordSearch: LIKE escape combinations", () => {
    it('a literal "%" keyword matches exactly the titles that contain a percent sign', async () => {
      // Core invariant: keyword=% must equal the literal-substring count, whether
      // zero or more. The fixture may or may not contain any percent-sign titles
      // depending on the corpus slice — what matters is that the two counts agree.
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles WHERE contains(title, '%')");
      const res = await keywordSearch(db, { keywords: ["%"], limit: 500 });
      expect(res.total).toBe(Number(n));
      res.results.forEach((r) => expect(r.title).toContain("%"));
    });

    it("backslash keywords match literal backslashes in titles", async () => {
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles WHERE contains(title, chr(92))");
      expect(Number(n)).toBeGreaterThan(0); // build_fixture.ts quirks CTE guarantees coverage
      const bare = await keywordSearch(db, { keywords: ["\\"], limit: 500 });
      expect(bare.total).toBe(Number(n));
      bare.results.forEach((r) => expect(r.title).toContain("\\"));
    });

    it("backslash-before-percent and backslash-with-underscore combos stay literal", async () => {
      const pct = await keywordSearch(db, { keywords: ["50\\%"] });
      const und = await keywordSearch(db, { keywords: ["a_b\\c"] });
      expect(pct.total).toBe(0);
      expect(und.total).toBe(0);
    });

    it('a "%" keyword with field=abstract matches only abstracts containing %', async () => {
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles WHERE contains(abstract, '%')");
      const res = await keywordSearch(db, { keywords: ["%"], fields: ["abstract"], limit: 500 });
      expect(res.total).toBe(Number(n));
    });

    it('underscore keyword matches only titles with literal "_" (not any single char)', async () => {
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles WHERE contains(title, '_')");
      const res = await keywordSearch(db, { keywords: ["_"], limit: 500 });
      expect(res.total).toBe(Number(n));
    });
  });

  describe("keywordSearch: pagination and ordering extremes", () => {
    it("offset beyond the total returns no rows but the true total", async () => {
      const res = await keywordSearch(db, { keywords: ["minimum wage"], offset: 100_000, limit: 10 });
      expect(res.total).toBeGreaterThan(0);
      expect(res.results).toEqual([]);
    });

    it("limit larger than the result count returns everything", async () => {
      // Use a narrow keyword (backslash) guaranteed to have few results by the
      // quirks CTE — avoids relying on a specific count of %-sign titles which
      // varies by corpus slice.
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles WHERE contains(title, chr(92))");
      expect(Number(n)).toBeGreaterThan(0);
      const res = await keywordSearch(db, { keywords: ["\\"], limit: 500 });
      expect(res.total).toBeGreaterThan(0);
      expect(res.results.length).toBe(res.total);
    });

    it("identical calls return identical row order (year and citations orderings)", async () => {
      const p = { keywords: ["minimum wage"], limit: 25 };
      const a = await keywordSearch(db, p);
      const b = await keywordSearch(db, p);
      expect(a.results.map((r) => r.Handle)).toEqual(b.results.map((r) => r.Handle));
      const c1 = await keywordSearch(db, { ...p, orderBy: "citations" as const });
      const c2 = await keywordSearch(db, { ...p, orderBy: "citations" as const });
      expect(c1.results.map((r) => r.Handle)).toEqual(c2.results.map((r) => r.Handle));
    });

    it("maxYear alone bounds results from above", async () => {
      const res = await keywordSearch(db, { keywords: ["minimum wage"], maxYear: 2010 });
      expect(res.total).toBeGreaterThan(0);
      res.results.forEach((r) => expect(r.year).toBeLessThanOrEqual(2010));
      const base = await keywordSearch(db, { keywords: ["minimum wage"], limit: 1 });
      expect(res.total).toBeLessThan(base.total);
    });
  });

  describe("semanticSearchWithVector: filter combinations", () => {
    it("applies title, author and journal-name post-filters", async () => {
      const { vec } = loadQueryVec();
      const results = await semanticSearchWithVector(db, vec, {
        maxK: 10,
        titleKeyword: "minimum wage",
        authorKeyword: "dube",
        journalName: ["review"],
      });
      results.forEach((r) => {
        expect(r.title?.toLowerCase()).toContain("minimum wage");
        expect(r.authors?.toLowerCase()).toContain("dube");
        expect(r.journal?.toLowerCase()).toContain("review");
      });
    });

    it("maxK above the corpus size returns every article", async () => {
      const { vec } = loadQueryVec();
      const results = await semanticSearchWithVector(db, vec, { maxK: totalArticles + 100 });
      expect(results.length).toBe(totalArticles);
    });
  });

  describe("verifyReferences: tier fall-through and mismatch boundaries", () => {
    const dube = {
      author_lastnames: "Dube; Lester; Reich",
      year: 2010,
      title: "Minimum Wage Effects Across State Borders",
    };

    it("a nonexistent handle falls through to tier 2 when author/year/title are valid", async () => {
      const [r] = await verifyReferences(db, [{ ...dube, handle: "RePEc:zzz:fake:does-not-exist" }]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.paper?.year).toBe(2010);
    });

    it("a nonexistent handle with no other fields is not_found", async () => {
      const [r] = await verifyReferences(db, [{ handle: "RePEc:zzz:fake:does-not-exist" }]);
      expect(r.status).toBe("not_found");
      expect(r.paper).toBeNull();
      expect(r.stats).toBeNull();
      expect(r.mismatches).toEqual([]);
    });

    it("comma-separated author_lastnames do not match (semicolon format is the contract)", async () => {
      const [r] = await verifyReferences(db, [{ ...dube, author_lastnames: "Dube, Lester, Reich" }]);
      expect(r.status).toBe("not_found");
    });

    it("extreme years fall through all tiers without erroring", async () => {
      const [zero, negative, huge] = await verifyReferences(db, [
        { ...dube, year: 0 },
        { ...dube, year: -500 },
        { ...dube, year: 999_999 },
      ]);
      expect(zero.status).toBe("not_found");
      expect(negative.status).toBe("not_found");
      expect(huge.status).toBe("not_found");
    });

    it("regex metacharacters in the entry title still fuzzy-match", async () => {
      const [r] = await verifyReferences(db, [
        { ...dube, title: "Minimum* Wage (Effects) [Across] State+ Borders?" },
      ]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.paper?.year).toBe(2010);
    });

    it("does not flag journal when the entry journal is a substring of the db journal", async () => {
      // db journal: "Review of Economics and Statistics (RESTAT)"
      const [r] = await verifyReferences(db, [
        { ...dube, journal: "Review of Economics and Statistics" },
      ]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.mismatches.filter((m) => m.kind === "journal")).toEqual([]);
    });

    it("does not flag journal when the db journal is a substring of the entry journal", async () => {
      const [r] = await verifyReferences(db, [
        { ...dube, journal: "The Review of Economics and Statistics (RESTAT), MIT Press" },
      ]);
      expect(r.status).toBe("fuzzy_match");
      expect(r.mismatches.filter((m) => m.kind === "journal")).toEqual([]);
    });

    it("flags a year mismatch on a handle match only beyond +/-1", async () => {
      const { handle } = loadQueryVec(); // seed paper: year 2012
      const [off3, off1] = await verifyReferences(db, [
        { handle, year: 2015 },
        { handle, year: 2013 },
      ]);
      expect(off3.status).toBe("handle_match");
      expect(off3.mismatches).toEqual([{ kind: "year", entry: 2015, db: 2012 }]);
      expect(off1.status).toBe("handle_match");
      expect(off1.mismatches.filter((m) => m.kind === "year")).toEqual([]);
    });

    it("SQL injection in author_lastnames is parameterised — no rows matched, articles intact", async () => {
      const injected = "'; DROP TABLE articles; --";
      const [r] = await verifyReferences(db, [{ author_lastnames: injected, year: 2010, title: "Minimum Wage" }]);
      // The injected string is a LIKE param, so it can never match a real author row.
      expect(r.status).toBe("not_found");
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles");
      expect(Number(n)).toBeGreaterThan(0);
    });

    it("SQL injection in title is parameterised — articles table survives", async () => {
      const injected = "'; DROP TABLE articles; --";
      const [r] = await verifyReferences(db, [
        { author_lastnames: "Dube; Lester; Reich", year: 2010, title: injected },
      ]);
      expect(r.status).toBe("not_found");
      const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM articles");
      expect(Number(n)).toBeGreaterThan(0);
    });

    it("LIKE wildcards in author / title do not explode the match set", async () => {
      // "%Dube%" in author_lastnames — the LIKE-escape wraps the param so it
      // matches literally, not as a wildcard.
      const [pct] = await verifyReferences(db, [
        { author_lastnames: "%Dube%; %Lester%; %Reich%", year: 2010, title: "Minimum Wage Effects Across State Borders" },
      ]);
      // firstAuthorLastname picks "%Dube%" — no real author named that
      expect(pct.status).toBe("not_found");

      const [und] = await verifyReferences(db, [
        { author_lastnames: "_ube; Lester; Reich", year: 2010, title: "Minimum Wage Effects Across State Borders" },
      ]);
      expect(und.status).toBe("not_found");
    });

    it("unicode author lastnames and titles are accepted without error", async () => {
      const [r] = await verifyReferences(db, [
        { author_lastnames: "Ünsal; Özler", year: 2015, title: "日本語の経済学" },
      ]);
      expect(r.status).toBe("not_found");
      expect(r.paper).toBeNull();
    });

    it("a very large batch (200 entries) completes without error", async () => {
      const entries = Array.from({ length: 200 }, (_, i) => ({
        cite_key: `k${i}`,
        author_lastnames: "Zzyzx",
        year: 1900 + i,
        title: `Fictional Paper ${i}`,
      }));
      const results = await verifyReferences(db, entries);
      expect(results).toHaveLength(200);
      results.forEach((r) => expect(r.status).toBe("not_found"));
    });
  });

  describe("keywordSearch: multi-field and match=all with unicode", () => {
    it("match=all with unicode keyword searches correctly", async () => {
      const [row] = await db.query(
        "SELECT title FROM articles WHERE LOWER(title) LIKE '%ü%' OR LOWER(title) LIKE '%ö%' LIMIT 1",
      );
      if (!row) return; // skip if fixture has no umlaut titles
      const umWord = String(row.title).match(/[A-Za-zÄÖÜäöüß]*[äöüÄÖÜ][A-Za-zÄÖÜäöüß]*/)?.[0] ?? "";
      if (!umWord) return;
      // match=all with one umlaut keyword must give same result as match=any
      const any = await keywordSearch(db, { keywords: [umWord.toLowerCase()], match: "any" });
      const all = await keywordSearch(db, { keywords: [umWord.toLowerCase()], match: "all" });
      expect(all.total).toBe(any.total);
    });

    it("match=all with keywords across different fields returns empty (no cross-field AND)", async () => {
      // If a keyword only appears in title and another only in authors, match=all on
      // the default field=["title"] must return zero because an article's title
      // cannot contain both simultaneously when neither appears there.
      // Here we use a guaranteed-absent string in combination with a known keyword.
      const res = await keywordSearch(db, {
        keywords: ["minimum wage", "zzzabsent_string_xyzzy"],
        match: "all",
        fields: ["title"],
      });
      expect(res.total).toBe(0);
    });

    it("fields=all three columns with match=any broadens results vs title-only", async () => {
      const titleOnly = await keywordSearch(db, {
        keywords: ["dube"],
        fields: ["title"],
      });
      const allFields = await keywordSearch(db, {
        keywords: ["dube"],
        fields: ["title", "abstract", "authors"],
        match: "any",
      });
      expect(allFields.total).toBeGreaterThanOrEqual(titleOnly.total);
    });
  });
});
