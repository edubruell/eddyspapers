import { describe, it, expect } from "vitest";
import { normalizeForParity, firstDiff } from "../../scripts/parityNormalize.js";

// The comparator collapses the two systematic Plumber↔Hono differences (auto_unbox=FALSE
// boxing + jsonlite digits=4) by applying the same transform to both sides. Samples below are
// the real wire shapes observed from prod Plumber.

describe("normalizeForParity", () => {
  it("unwraps one-element (boxed) arrays and rounds numbers to 4 decimals", () => {
    expect(normalizeForParity({ handle: ["x"], n: [5], r: [9.46153846] })).toEqual({
      handle: "x",
      n: 5,
      r: 9.4615,
    });
  });

  it("keeps JSON-string columns as strings", () => {
    expect(normalizeForParity({ citations_by_year: ['{"years":[2013],"counts":[1]}'] })).toEqual({
      citations_by_year: '{"years":[2013],"counts":[1]}',
    });
  });

  it("drops volatile keys (hash / created_at / timestamp / search_id / response_time_ms)", () => {
    expect(
      normalizeForParity({ hash: ["abc"], created_at: ["t"], search_id: [7], query: ["q"] }),
    ).toEqual({ query: "q" });
  });

  it("preserves multi-element arrays and normalises their elements", () => {
    expect(normalizeForParity({ results: [{ a: [1] }, { a: [2.00001] }] })).toEqual({
      results: [{ a: 1 }, { a: 2.0 }],
    });
  });

  it("makes a Plumber-boxed handlestats equal to the same row unboxed", () => {
    // Plumber wire (boxed) vs a hypothetical Hono wire that is ALSO boxed (both normalise equal),
    // and vs an unboxed variant — all three collapse to one shape.
    const plumber = { handle: ["repec:x"], total_citations: [123], citations_per_year: [9.4615] };
    const honoBoxed = { handle: ["repec:x"], total_citations: [123], citations_per_year: [9.46153846] };
    expect(firstDiff(normalizeForParity(plumber), normalizeForParity(honoBoxed))).toBeNull();
  });

  it("makes a boxed person row equal to the scalar person row Hono returns", () => {
    const plumber = {
      short_id: ["pne16"],
      score: [15.1792],
      stats: { n_works_in_corpus: [168], first_year: [1995] },
      evidence: [{ handle: ["repec:iza:izadps:dp11999"], score: [0.8184] }],
    };
    const hono = {
      short_id: "pne16",
      score: 15.17924,
      stats: { n_works_in_corpus: 168, first_year: 1995 },
      evidence: [{ handle: "repec:iza:izadps:dp11999", score: 0.8184 }],
    };
    expect(firstDiff(normalizeForParity(plumber), normalizeForParity(hono))).toBeNull();
  });
});

describe("firstDiff", () => {
  it("returns null for equal values and a path for the first difference", () => {
    expect(firstDiff({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBeNull();
    expect(firstDiff({ a: 1 }, { a: 2 })).toContain("$.a");
    expect(firstDiff({ b: [2, 3] }, { b: [2, 4] })).toContain("$.b[1]");
    expect(firstDiff([1, 2], [1, 2, 3])).toContain("length");
  });
});
