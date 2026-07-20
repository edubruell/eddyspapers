import { describe, it, expect } from "vitest";
import { computeFlags, summarizeResult } from "../../src/agent/stages/assess.js";
import type { Paper, Person, Section } from "../../src/agent/types.js";

// Person-aware assessor inputs: persons count as results, so a person-finder brief
// that returns zero papers must not be flagged all_empty (which would push the
// refine advisor toward a pointless "broaden" pass).

function paper(handle: string): Paper {
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
  };
}

function person(short_id: string, over: Partial<Person> = {}): Person {
  return {
    short_id,
    name: `Name ${short_id}`,
    affiliation: "Inst",
    homepage: null,
    image_url: null,
    wikipedia_url: null,
    orcid: null,
    url: `https://ideas.repec.org/e/${short_id}.html`,
    n_works: 10,
    citations: 100,
    first_year: 2000,
    last_year: 2026,
    primary_category: "C",
    n_matched: 3,
    birth_year: null,
    birth_place: null,
    citizenships: [],
    educated_at: [],
    doctoral_advisors: [],
    doctoral_students: [],
    memberships: [],
    awards: [],
    google_scholar_id: null,
    ssrn_author_id: null,
    math_genealogy_id: null,
    website: null,
    evidence: [],
    ...over,
  };
}

function section(id: string, title: string, n: number, kind?: "papers" | "persons"): Section {
  return {
    id,
    title,
    mode: kind === "persons" ? "person" : "custom",
    kind,
    n_total: n,
    n_shown: n,
    rows: Array.from({ length: n }, (_, i) => ({ handle: `h${i}`, rank: i + 1 })),
  };
}

const papersOf = (...hs: string[]): Record<string, Paper> =>
  Object.fromEntries(hs.map((h) => [h, paper(h)]));
const personsOf = (...ids: string[]): Record<string, Person> =>
  Object.fromEntries(ids.map((i) => [i, person(i)]));

describe("computeFlags with persons", () => {
  it("a person-only result is NOT all_empty", () => {
    const f = computeFlags({}, [section("s1", "People", 3, "persons")], 0, personsOf("p1", "p2", "p3"));
    expect(f.all_empty).toBe(false);
  });

  it("zero papers AND zero persons is all_empty", () => {
    const f = computeFlags({}, [], 0, {});
    expect(f.all_empty).toBe(true);
  });

  it("omitting the persons argument keeps the legacy paper-only behavior", () => {
    expect(computeFlags({}, []).all_empty).toBe(true);
    expect(computeFlags(papersOf("a"), [section("s1", "S", 1)]).all_empty).toBe(false);
  });

  it("persons count toward the thin threshold jointly with papers", () => {
    // 2 papers + 2 persons = 4 < 5 → thin
    expect(
      computeFlags(papersOf("a", "b"), [section("s1", "S", 4)], 0, personsOf("p1", "p2")).thin,
    ).toBe(true);
    // 2 papers + 3 persons = 5 → not thin
    expect(
      computeFlags(papersOf("a", "b"), [section("s1", "S", 5)], 0, personsOf("p1", "p2", "p3")).thin,
    ).toBe(false);
  });

  it("a thin person-only result is flagged thin, not all_empty", () => {
    const f = computeFlags({}, [section("s1", "People", 1, "persons")], 0, personsOf("p1"));
    expect(f.all_empty).toBe(false);
    expect(f.thin).toBe(true);
  });

  it("no_new compares the joint paper+person total against priorCount", () => {
    expect(computeFlags(papersOf("a"), [], 3, personsOf("p1", "p2")).no_new).toBe(true);
    expect(computeFlags(papersOf("a"), [], 2, personsOf("p1", "p2")).no_new).toBe(false);
  });

  it("headline_empty still works when the trailing empty section is a person section", () => {
    const sections = [section("s1", "Papers", 4), section("s2", "People", 0, "persons")];
    const f = computeFlags(papersOf("a", "b"), sections, 0, {});
    expect(f.headline_empty).toBe(true);
  });
});

describe("summarizeResult with persons", () => {
  it("labels person sections as person(s) and paper sections as paper(s)", () => {
    const sections = [section("s1", "Top papers", 3), section("s2", "Who to talk to", 2, "persons")];
    const out = summarizeResult(papersOf("a"), sections, personsOf("p1", "p2"));
    expect(out).toMatch(/"Top papers": 3 paper\(s\)/);
    expect(out).toMatch(/"Who to talk to": 2 person\(s\)/);
  });

  it("appends a person block with count and a sample capped at 5", () => {
    const persons = personsOf("p1", "p2", "p3", "p4", "p5", "p6", "p7");
    const out = summarizeResult({}, [section("s1", "People", 7, "persons")], persons);
    expect(out).toMatch(/Distinct persons: 7/);
    const sampleLines = out
      .split("Person sample:")[1]
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(sampleLines.length).toBe(5);
    expect(sampleLines[0]).toMatch(/Name p1 \(Inst\)/);
  });

  it("falls back to ? for a missing affiliation", () => {
    const persons = { p1: person("p1", { affiliation: null }) };
    const out = summarizeResult({}, [], persons);
    expect(out).toMatch(/Name p1 \(\?\)/);
  });

  it("omits the person block entirely when there are no persons", () => {
    const out = summarizeResult(papersOf("a"), [section("s1", "S", 1)], {});
    expect(out).not.toMatch(/Distinct persons/);
    expect(out).not.toMatch(/Person sample/);
  });

  it("omitting the persons argument keeps the legacy signature working", () => {
    const out = summarizeResult(papersOf("a"), [section("s1", "S", 1)]);
    expect(out).toMatch(/Distinct papers: 1/);
    expect(out).not.toMatch(/Distinct persons/);
  });
});
