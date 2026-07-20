import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CorpusDb } from "../../src/db/corpus.js";
import { corpusGuide } from "../../src/search/guide.js";
import { openFixture } from "./helpers.js";

describe("corpusGuide (fixture)", () => {
  let db: CorpusDb;
  beforeAll(async () => {
    db = await openFixture();
  });
  afterAll(() => db.close());

  it("assembles counts, categories, and doctrine", async () => {
    const guide = await corpusGuide(db);
    expect(guide.total_articles).toBeGreaterThan(1000);
    expect(guide.total_persons).toBeGreaterThan(100);
    expect(guide.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // the fixture slice covers all seven ranking tiers
    expect(guide.categories.length).toBe(7);
    guide.categories.forEach((c) => {
      expect(c.n).toBeGreaterThan(0);
      expect(c.example_journals.length).toBeGreaterThan(0);
    });
    expect(guide.semantic_query_guidance).toContain("3-6 sentences");
    expect(guide.default_category_mix).toContain("Top 5 Journals");
    expect(guide.person_scoring_modes).toEqual(["breadth", "best_match", "blended"]);
  });

  it("is cached per process (same object back)", async () => {
    const a = await corpusGuide(db);
    const b = await corpusGuide(db);
    expect(b).toBe(a);
  });
});
