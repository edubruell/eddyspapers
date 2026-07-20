import { describe, it, expect } from "vitest";
import { computeFlags, summarizeResult } from "../../src/agent/stages/assess.js";
import type { Paper, Section } from "../../src/agent/types.js";

function paper(handle: string, over: Partial<Paper> = {}): Paper {
  return {
    handle,
    title: `Title ${handle}`,
    authors: ["A"],
    year: 2020,
    journal: "J",
    category: "C",
    url: "",
    abstract: null,
    bibtex: "",
    ...over,
  };
}

function section(id: string, title: string, n: number): Section {
  return {
    id,
    title,
    mode: "custom",
    n_total: n,
    n_shown: n,
    rows: Array.from({ length: n }, (_, i) => ({ handle: `h${i}`, rank: i + 1 })),
  };
}

const papersOf = (...handles: string[]): Record<string, Paper> =>
  Object.fromEntries(handles.map((h) => [h, paper(h)]));

// ── computeFlags ───────────────────────────────────────────────────────────

describe("computeFlags", () => {
  it("flags all_empty when there are no papers", () => {
    const f = computeFlags({}, []);
    expect(f.all_empty).toBe(true);
    expect(f.thin).toBe(false); // thin requires at least one paper
  });

  it("flags headline_empty when the last section is empty but an earlier one is not", () => {
    const sections = [section("s1", "Candidates", 12), section("s2", "Published", 0)];
    const f = computeFlags(papersOf("a", "b", "c"), sections);
    expect(f.headline_empty).toBe(true);
    expect(f.all_empty).toBe(false);
  });

  it("does NOT flag headline_empty with a single section", () => {
    const f = computeFlags(papersOf("a"), [section("s1", "Only", 0)]);
    expect(f.headline_empty).toBe(false);
  });

  it("does NOT flag headline_empty when the last section is populated", () => {
    const sections = [section("s1", "A", 3), section("s2", "B", 5)];
    const f = computeFlags(papersOf("a", "b", "c", "d", "e"), sections);
    expect(f.headline_empty).toBe(false);
  });

  it("flags thin when fewer than 5 distinct papers", () => {
    expect(computeFlags(papersOf("a"), [section("s1", "S", 1)]).thin).toBe(true);
    expect(computeFlags(papersOf("a", "b", "c", "d"), [section("s1", "S", 4)]).thin).toBe(true);
  });

  it("does NOT flag thin at exactly 5 papers", () => {
    const f = computeFlags(papersOf("a", "b", "c", "d", "e"), [section("s1", "S", 5)]);
    expect(f.thin).toBe(false);
  });

  it("flags no_new when this round adds nothing over the prior count", () => {
    expect(computeFlags(papersOf("a", "b"), [section("s1", "S", 2)], 2).no_new).toBe(true);
    expect(computeFlags(papersOf("a", "b"), [section("s1", "S", 2)], 3).no_new).toBe(true);
    expect(computeFlags(papersOf("a", "b", "c"), [section("s1", "S", 3)], 2).no_new).toBe(false);
  });

  it("treats round 1 (priorCount 0) with results as no_new=false", () => {
    expect(computeFlags(papersOf("a"), [section("s1", "S", 1)]).no_new).toBe(false);
  });
});

// ── summarizeResult ──────────────────────────────────────────────────────────

describe("summarizeResult", () => {
  it("lists section titles with counts and the distinct-paper total", () => {
    const sections = [section("s1", "Top-cited", 3), section("s2", "Recent WPs", 2)];
    const out = summarizeResult(papersOf("a", "b", "c"), sections);
    expect(out).toMatch(/"Top-cited": 3 paper/);
    expect(out).toMatch(/"Recent WPs": 2 paper/);
    expect(out).toMatch(/Distinct papers: 3/);
  });

  it("caps the sample at 5 rows", () => {
    const handles = Array.from({ length: 12 }, (_, i) => `h${i}`);
    const out = summarizeResult(papersOf(...handles), [section("s1", "S", 12)]);
    const sampleLines = out.split("Sample:")[1].trim().split("\n").filter(Boolean);
    expect(sampleLines.length).toBe(5);
  });

  it("handles the empty result gracefully", () => {
    const out = summarizeResult({}, []);
    expect(out).toMatch(/no sections emitted/);
    expect(out).toMatch(/Distinct papers: 0/);
    expect(out).toMatch(/\(none\)/);
  });
});
