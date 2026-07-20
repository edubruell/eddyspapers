import { describe, it, expect } from "vitest";
import { parseRawEvent } from "../../src/sandbox/events.js";

// Regression: keyword/SQL papers arrive with `similarity: null` (R emits explicit
// null, not absent) and some articles have null authors/title. The schema must
// accept these and coerce, not drop the whole paper — otherwise keyword sections
// render with no cards.
describe("paper event null tolerance", () => {
  it("accepts a paper with similarity: null (keyword/SQL papers)", () => {
    const e = parseRawEvent({
      type: "paper",
      handle: "RePEc:aea:aecrev:v:115:y:2025:i:1:p:117-46",
      title: "Price Floors and Employer Preferences",
      year: 2025,
      authors: "John J. Horton",
      journal: "American Economic Review",
      category: "Top 5 Journals",
      url: "https://example.org/x",
      similarity: null,
      abstract: null,
    });
    expect(e).not.toBeNull();
    expect(e?.type).toBe("paper");
    if (e?.type === "paper") expect(e.similarity ?? null).toBeNull();
  });

  it("coerces null string fields to empty rather than dropping the paper", () => {
    const e = parseRawEvent({
      type: "paper",
      handle: "RePEc:xxx:1",
      title: null,
      year: null,
      authors: null,
      journal: null,
      category: null,
      url: "https://example.org/y",
    });
    expect(e).not.toBeNull();
    if (e?.type === "paper") {
      expect(e.title).toBe("");
      expect(e.authors).toBe("");
      expect(e.journal).toBe("");
      expect(e.category).toBe("");
      expect(e.year).toBe(0);
    }
  });

  it("still rejects a paper missing the required handle", () => {
    const e = parseRawEvent({ type: "paper", title: "x", url: "https://e/z" });
    expect(e).toBeNull();
  });
});
