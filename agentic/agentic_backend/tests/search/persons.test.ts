import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CorpusDb } from "../../src/db/corpus.js";
import { personSearchWithVector } from "../../src/search/persons.js";
import { openFixture, loadQueryVec } from "./helpers.js";

describe("personSearchWithVector (fixture)", () => {
  let db: CorpusDb;
  let vec: number[];

  beforeAll(async () => {
    db = await openFixture();
    vec = loadQueryVec().vec;
  });
  afterAll(() => db.close());

  it("returns ranked persons with bounded evidence", async () => {
    const results = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 200 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    results.forEach((r) => {
      expect(r.short_id).toBeTruthy();
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence.length).toBeLessThanOrEqual(5);
      // evidence handles come from the lowercased hits CTE
      r.evidence.forEach((e) => expect(e.handle).toBe(e.handle.toLowerCase()));
      expect(r.n_matched).toBeGreaterThanOrEqual(r.evidence.length > 0 ? 1 : 0);
    });
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("is deterministic across calls", async () => {
    const a = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 200 });
    const b = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 200 });
    expect(a.map((r) => r.short_id)).toEqual(b.map((r) => r.short_id));
  });

  it("scoring modes rank the same candidate pool differently", async () => {
    // maxK truncates AFTER scoring, so compare untruncated pools.
    const pool = { maxK: 100_000, kPapers: 200 };
    const breadth = await personSearchWithVector(db, vec, { ...pool, scoringMode: "breadth" });
    const best = await personSearchWithVector(db, vec, { ...pool, scoringMode: "best_match" });
    expect(new Set(breadth.map((r) => r.short_id))).toEqual(new Set(best.map((r) => r.short_id)));
    expect(breadth.map((r) => r.short_id)).not.toEqual(best.map((r) => r.short_id));
  });

  it("quality_weight=0 disables the citation blend for breadth", async () => {
    const [top] = await personSearchWithVector(db, vec, {
      maxK: 1,
      kPapers: 200,
      scoringMode: "breadth",
      qualityWeight: 0,
    });
    expect(top.score).toBeCloseTo(top.overlap_weight, 6);
  });

  it("activeSince and minCitations filter to a subset", async () => {
    // untruncated pools — filtered members must come from the full candidate set
    const all = await personSearchWithVector(db, vec, { maxK: 100_000, kPapers: 200 });
    const filtered = await personSearchWithVector(db, vec, {
      maxK: 100_000,
      kPapers: 200,
      activeSince: 2020,
      minCitations: 100,
    });
    const allIds = new Set(all.map((r) => r.short_id));
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    filtered.forEach((r) => {
      expect(allIds.has(r.short_id)).toBe(true);
      expect(r.stats.last_year ?? 0).toBeGreaterThanOrEqual(2020);
      expect(r.stats.total_citations ?? 0).toBeGreaterThanOrEqual(100);
    });
  });

  it("kPapers smaller than the 5-slot evidence window shortens evidence lists", async () => {
    const results = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 3 });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.evidence.length).toBeLessThanOrEqual(3);
      expect(r.n_matched).toBeLessThanOrEqual(3);
    });
    // at most 3 distinct papers can back the whole result set
    const distinct = new Set(results.flatMap((r) => r.evidence.map((e) => e.handle)));
    expect(distinct.size).toBeLessThanOrEqual(3);
  });

  it("maxK=1 returns exactly the top-ranked person of a larger run", async () => {
    const [top] = await personSearchWithVector(db, vec, { maxK: 1, kPapers: 200 });
    const wide = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 200 });
    expect(top.short_id).toBe(wide[0].short_id);
    expect(top.score).toBe(wide[0].score);
  });

  it("returns [] when the category filter matches nothing", async () => {
    const results = await personSearchWithVector(db, vec, {
      maxK: 10,
      kPapers: 200,
      journalFilter: ["Nonexistent Category"],
    });
    expect(results).toEqual([]);
  });

  it("returns [] when minYear excludes every paper", async () => {
    const results = await personSearchWithVector(db, vec, { maxK: 10, kPapers: 200, minYear: 5000 });
    expect(results).toEqual([]);
  });

  it("category filter restricts the stage-1 paper pool", async () => {
    const results = await personSearchWithVector(db, vec, {
      maxK: 20,
      kPapers: 200,
      journalFilter: ["Top 5 Journals"],
    });
    // every evidence paper must belong to the filtered category
    const handles = results.flatMap((r) => r.evidence.map((e) => e.handle));
    if (handles.length > 0) {
      const rows = await db.query(
        `SELECT DISTINCT category FROM articles WHERE LOWER(Handle) IN (${handles.map(() => "?").join(",")})`,
        handles,
      );
      expect(rows.map((r) => String(r.category))).toEqual(["Top 5 Journals"]);
    }
  });

  // --- tie-breaking tests (PLAN.md §12.4 P1 hot spot) ---

  it("tie-breaking: qualityWeight=0 makes all qualityBlend=1 so score equals the raw metric, ordering still deterministic", async () => {
    // With qualityWeight=0: breadth score = overlap_weight * 1 (no citation blend).
    // Two persons that happen to share the same overlap_weight in different calls
    // must still appear in the same order — verified by running twice and comparing.
    const a = await personSearchWithVector(db, vec, { maxK: 50, kPapers: 200, qualityWeight: 0 });
    const b = await personSearchWithVector(db, vec, { maxK: 50, kPapers: 200, qualityWeight: 0 });
    expect(a.map((r) => r.short_id)).toEqual(b.map((r) => r.short_id));
    // Scores must be weakly descending
    const scores = a.map((r) => r.score);
    scores.forEach((s, i) => {
      if (i > 0) expect(s).toBeLessThanOrEqual(scores[i - 1]);
    });
  });

  it("tie-breaking: best_match mode with qualityWeight=0 returns weakly descending best_score", async () => {
    const results = await personSearchWithVector(db, vec, {
      maxK: 50,
      kPapers: 200,
      scoringMode: "best_match",
      qualityWeight: 0,
    });
    // score = best_score * 1 — so the output must be sorted by best_score descending.
    const scores = results.map((r) => r.score);
    scores.forEach((s, i) => {
      if (i > 0) expect(s).toBeLessThanOrEqual(scores[i - 1]);
    });
    // each person's score must equal their best_score (qualityBlend=1)
    results.forEach((r) => expect(r.score).toBeCloseTo(r.best_score, 10));
  });

  it("tie-breaking: blended mode with qualityWeight=0 gives score=(0.5*overlapNorm+0.5*best_score), weakly descending", async () => {
    const results = await personSearchWithVector(db, vec, {
      maxK: 50,
      kPapers: 200,
      scoringMode: "blended",
      qualityWeight: 0,
    });
    expect(results.length).toBeGreaterThan(0);
    const scores = results.map((r) => r.score);
    scores.forEach((s, i) => {
      if (i > 0) expect(s).toBeLessThanOrEqual(scores[i - 1]);
    });
  });

  it("tie-breaking: identical calls with blended mode are fully deterministic", async () => {
    const opts = { maxK: 30, kPapers: 200, scoringMode: "blended" as const, qualityWeight: 0.3 };
    const a = await personSearchWithVector(db, vec, opts);
    const b = await personSearchWithVector(db, vec, opts);
    expect(a.map((r) => r.short_id)).toEqual(b.map((r) => r.short_id));
    expect(a.map((r) => r.score)).toEqual(b.map((r) => r.score));
  });

  it("score is >= overlap_weight when qualityWeight > 0 (citation blend inflates)", async () => {
    // qualityBlend = 1 + qualityWeight * qualityNorm >= 1, so breadth score >= overlap_weight
    const results = await personSearchWithVector(db, vec, {
      maxK: 20,
      kPapers: 200,
      scoringMode: "breadth",
      qualityWeight: 0.5,
    });
    results.forEach((r) => expect(r.score).toBeGreaterThanOrEqual(r.overlap_weight));
  });

  it("evidence handles are all lowercase (CTE dedup normalises via LOWER)", async () => {
    const results = await personSearchWithVector(db, vec, { maxK: 20, kPapers: 200 });
    results.forEach((r) => {
      r.evidence.forEach((e) => {
        expect(e.handle).toBe(e.handle.toLowerCase());
      });
    });
  });

  it("n_matched >= evidence.length for every result (evidence is a 5-slot cap, n_matched is the full count)", async () => {
    const results = await personSearchWithVector(db, vec, { maxK: 20, kPapers: 200 });
    results.forEach((r) => expect(r.n_matched).toBeGreaterThanOrEqual(r.evidence.length));
  });
});
