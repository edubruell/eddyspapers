import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CorpusDb } from "../../src/db/corpus.js";
import { keywordSearch, semanticSearchWithVector } from "../../src/search/papers.js";
import { openFixture, loadQueryVec } from "./helpers.js";

// M8 Wave 1: the jel filter fragment + doi surfacing in PAPER_COLS/rowToPaper,
// exercised against real article_jel/doi rows in the fixture. Anchor codes are
// derived from the fixture (not hardcoded) so a rebuilt slice keeps the tests
// honest — preconditions assert the shape the derivation relies on.

const MW = ["minimum wage"];

describe("jel filter + doi surfacing (fixture-backed)", () => {
  let db: CorpusDb;
  let exactCode = ""; // most common 3-char JEL code among minimum-wage titles (e.g. "J38")
  let prefix = ""; // its 2-char family prefix (e.g. "J3")

  beforeAll(async () => {
    db = await openFixture();
    const rows = await db.query(
      `SELECT j.jel_code, COUNT(*) AS n
       FROM articles a JOIN article_jel j ON j.handle = LOWER(a.Handle)
       WHERE LOWER(a.title) LIKE '%minimum wage%' AND LENGTH(j.jel_code) = 3
       GROUP BY j.jel_code ORDER BY n DESC, j.jel_code LIMIT 1`,
    );
    expect(rows.length).toBe(1); // fixture precondition: JEL-coded minimum-wage papers exist
    exactCode = String(rows[0].jel_code);
    prefix = exactCode.slice(0, 2);
  });
  afterAll(() => db.close());

  const hasJelLike = async (handle: string, pattern: string): Promise<boolean> => {
    const r = await db.query(
      "SELECT COUNT(*) AS n FROM article_jel WHERE handle = LOWER(?) AND jel_code LIKE ?",
      [handle, pattern],
    );
    return Number(r[0].n) > 0;
  };

  describe("keywordSearch", () => {
    it("an exact code restricts results to papers carrying it", async () => {
      const unfiltered = await keywordSearch(db, { keywords: MW, limit: 500 });
      const filtered = await keywordSearch(db, { keywords: MW, jel: [exactCode], limit: 500 });
      expect(filtered.total).toBeGreaterThan(0);
      expect(filtered.total).toBeLessThan(unfiltered.total);
      for (const r of filtered.results) {
        expect(await hasJelLike(r.Handle, `${exactCode}%`)).toBe(true);
      }
    });

    it("a 2-char prefix widens the match over the exact 3-char code", async () => {
      // Precondition: the family has sibling codes in the slice, so prefix > exact.
      const siblings = await db.query(
        "SELECT COUNT(*) AS n FROM article_jel WHERE jel_code LIKE ? AND jel_code <> ?",
        [`${prefix}%`, exactCode],
      );
      expect(Number(siblings[0].n)).toBeGreaterThan(0); // else the fixture slice changed

      const exact = await keywordSearch(db, { keywords: MW, jel: [exactCode], limit: 500 });
      const wide = await keywordSearch(db, { keywords: MW, jel: [prefix], limit: 500 });
      expect(wide.total).toBeGreaterThan(exact.total);

      // Every exact-filtered paper is also prefix-filtered (subset is only sound
      // when both pages are complete).
      expect(exact.total).toBeLessThanOrEqual(500);
      expect(wide.total).toBeLessThanOrEqual(500);
      const wideHandles = new Set(wide.results.map((r) => r.Handle));
      for (const r of exact.results) expect(wideHandles.has(r.Handle)).toBe(true);
    });

    it("multiple codes are OR-ed (union at least as large as either alone)", async () => {
      const a = await keywordSearch(db, { keywords: MW, jel: [exactCode], limit: 500 });
      const both = await keywordSearch(db, { keywords: MW, jel: [exactCode, "E24"], limit: 500 });
      expect(both.total).toBeGreaterThanOrEqual(a.total);
    });

    it("drops invalid codes without a SQL error (all-invalid = unfiltered)", async () => {
      const unfiltered = await keywordSearch(db, { keywords: MW, limit: 500 });
      const junk = await keywordSearch(db, {
        keywords: MW,
        jel: ["J381", "%", "_", "j3%", "'; DROP TABLE articles; --"],
        limit: 500,
      });
      expect(junk.total).toBe(unfiltered.total);
      const still = await db.query("SELECT COUNT(*) AS n FROM articles");
      expect(Number(still[0].n)).toBeGreaterThan(0);
    });

    it("mixing invalid with valid keeps only the valid code", async () => {
      const exact = await keywordSearch(db, { keywords: MW, jel: [exactCode], limit: 500 });
      const mixed = await keywordSearch(db, { keywords: MW, jel: [exactCode, "%", "Z999"], limit: 500 });
      expect(mixed.total).toBe(exact.total);
    });

    it("normalises case and whitespace in codes", async () => {
      const canon = await keywordSearch(db, { keywords: MW, jel: [exactCode], limit: 500 });
      const messy = await keywordSearch(db, {
        keywords: MW,
        jel: [`  ${exactCode.toLowerCase()}  `],
        limit: 500,
      });
      expect(messy.total).toBe(canon.total);
    });
  });

  describe("semanticSearchWithVector", () => {
    it("excludes papers without JEL rows (the seed paper has none)", async () => {
      const { handle, vec } = loadQueryVec();
      const seedJel = await db.query(
        "SELECT COUNT(*) AS n FROM article_jel WHERE handle = LOWER(?)",
        [handle],
      );
      expect(Number(seedJel[0].n)).toBe(0); // else the fixture slice changed — pick a new anchor

      const results = await semanticSearchWithVector(db, vec, { maxK: 50, jel: [prefix] });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.Handle).not.toBe(handle);
        expect(await hasJelLike(r.Handle, `${prefix}%`)).toBe(true);
      }
    });
  });

  describe("doi in results (PAPER_COLS + rowToPaper)", () => {
    it("keywordSearch surfaces the stored doi, null where absent", async () => {
      const dbRows = await db.query(
        "SELECT Handle, doi FROM articles WHERE LOWER(title) LIKE '%minimum wage%'",
      );
      const expected = new Map(dbRows.map((r) => [String(r.Handle), r.doi as string | null]));

      const { results } = await keywordSearch(db, { keywords: MW, limit: 200 });
      for (const r of results) {
        expect(r.doi).toBe(expected.get(r.Handle) ?? null);
      }
      const dois = results.map((r) => r.doi);
      expect(dois.some((d) => d !== null)).toBe(true); // fixture carries real DOIs
      expect(dois.some((d) => d === null)).toBe(true); // and DOI-less rows stay null
    });

    it("semantic search returns the seed paper's known doi", async () => {
      const { handle, vec } = loadQueryVec();
      const [seed] = await db.query("SELECT doi FROM articles WHERE Handle = ?", [handle]);
      expect(seed.doi).toBeTruthy(); // fixture precondition: seed paper carries a DOI

      const results = await semanticSearchWithVector(db, vec, { maxK: 5 });
      expect(results[0].Handle).toBe(handle);
      expect(results[0].doi).toBe(seed.doi);
    });
  });
});
