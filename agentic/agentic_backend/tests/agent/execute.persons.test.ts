import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRawEvent, type RawSandboxEvent } from "../../src/sandbox/events.js";
import type { StreamEventPayload } from "../../src/agent/types.js";

// executeScript translation of person / person_section raw events into the typed
// ExecuteResult + StreamEventPayloads. runSandbox is mocked; raw JSON objects are run
// through parseRawEvent first so the zod transforms (null coercion, mode whitelist)
// apply exactly as in production.

const runSandbox = vi.fn();
vi.mock("../../src/sandbox/runSandbox.js", () => ({
  runSandbox: (...a: unknown[]) => runSandbox(...a),
}));

type SandboxResult = {
  events: RawSandboxEvent[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function mockRun(rawJson: unknown[], over: Partial<SandboxResult> = {}): void {
  runSandbox.mockImplementation(
    async (_script: string, _db: string, onEvent: (e: RawSandboxEvent) => void) => {
      const events = rawJson
        .map((j) => parseRawEvent(j))
        .filter((e): e is RawSandboxEvent => e !== null);
      events.forEach(onEvent);
      return { events, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...over };
    },
  );
}

const personRaw = {
  type: "person",
  short_id: "pne16",
  name: "David Neumark",
  affiliation: "UC Irvine",
  homepage: "",
  image_url: null,
  wikipedia_url: null,
  orcid: null,
  url: "https://ideas.repec.org/e/pne16.html",
  n_works: 168,
  citations: 6719,
  first_year: 1995,
  last_year: 2026,
  primary_category: "Working Paper Series",
  n_matched: 27,
  evidence: [
    { handle: "repec:x:1", title: "T1", journal: "JHR", year: 2002, score: 0.88 },
  ],
};

const personSectionRaw = {
  type: "person_section",
  title: "Researchers active on minimum wages",
  short_ids: ["pne16"],
  note: null,
};

const paperRaw = {
  type: "paper",
  handle: "RePEc:x:2",
  title: "P",
  year: 2020,
  authors: "A One",
  journal: "J",
  category: "C",
  url: "https://e/x2",
  similarity: 0.91,
  abstract: null,
};

const paperSectionRaw = {
  type: "section",
  title: "Key papers",
  handles: ["RePEc:x:2"],
  note: null,
  mode: "semantic",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeScript — person translation", () => {
  it("collects persons keyed by short_id and emits a person stream event", async () => {
    mockRun([personRaw, personSectionRaw]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const emitted: StreamEventPayload[] = [];
    const r = await executeScript("x <- 1", "/fake/db.duckdb", (e) => emitted.push(e));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.persons)).toEqual(["pne16"]);
    const p = r.persons.pne16;
    expect(p.name).toBe("David Neumark");
    // empty-string homepage normalizes to null
    expect(p.homepage).toBeNull();
    expect(p.image_url).toBeNull();
    expect(p.citations).toBe(6719);
    expect(p.evidence).toHaveLength(1);

    const personEvents = emitted.filter((e) => e.type === "person");
    expect(personEvents).toHaveLength(1);
  });

  it("translates a person_section into a persons-kind section with short_ids as row handles", async () => {
    mockRun([personRaw, personSectionRaw]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const emitted: StreamEventPayload[] = [];
    const r = await executeScript("x <- 1", "/fake/db.duckdb", (e) => emitted.push(e));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections).toHaveLength(1);
    const s = r.sections[0];
    expect(s.kind).toBe("persons");
    expect(s.mode).toBe("person");
    expect(s.id).toBe("section-1");
    expect(s.rows).toEqual([{ handle: "pne16", rank: 1 }]);
    expect(s.n_total).toBe(1);
    // note: null arrives as undefined
    expect(s.note).toBeUndefined();

    const sectionEvents = emitted.filter((e) => e.type === "section");
    expect(sectionEvents).toHaveLength(1);
  });

  it("maps the full wikidata enrichment block onto the Person", async () => {
    mockRun([
      {
        ...personRaw,
        short_id: "pkr12",
        birth_year: 1953,
        birth_place: "Albany",
        citizenships: ["United States"],
        educated_at: ["MIT", "Yale University"],
        doctoral_advisors: ["Rudi Dornbusch"],
        doctoral_students: ["Steven Brakman", "Gordon Hanson"],
        memberships: ["Econometric Society"],
        awards: ["Nobel", "Clark Medal"],
        google_scholar_id: "abc123",
        ssrn_author_id: "98765",
        math_genealogy_id: "55555",
        website: "https://krugman.example",
      },
      { type: "person_section", title: "S", short_ids: ["pkr12"] },
    ]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.persons.pkr12;
    expect(p.birth_year).toBe(1953);
    expect(p.birth_place).toBe("Albany");
    expect(p.citizenships).toEqual(["United States"]);
    expect(p.educated_at).toEqual(["MIT", "Yale University"]);
    expect(p.doctoral_advisors).toEqual(["Rudi Dornbusch"]);
    expect(p.doctoral_students).toEqual(["Steven Brakman", "Gordon Hanson"]);
    expect(p.memberships).toEqual(["Econometric Society"]);
    expect(p.awards).toEqual(["Nobel", "Clark Medal"]);
    expect(p.google_scholar_id).toBe("abc123");
    expect(p.ssrn_author_id).toBe("98765");
    expect(p.math_genealogy_id).toBe("55555");
    expect(p.website).toBe("https://krugman.example");
  });

  it("defaults absent wikidata arrays to [] and absent scalars to null", async () => {
    // personRaw / personSectionRaw carry no enrichment keys at all.
    mockRun([personRaw, personSectionRaw]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.persons.pne16;
    expect(p.citizenships).toEqual([]);
    expect(p.educated_at).toEqual([]);
    expect(p.doctoral_advisors).toEqual([]);
    expect(p.doctoral_students).toEqual([]);
    expect(p.memberships).toEqual([]);
    expect(p.awards).toEqual([]);
    expect(p.birth_year).toBeNull();
    expect(p.birth_place).toBeNull();
    expect(p.google_scholar_id).toBeNull();
    expect(p.ssrn_author_id).toBeNull();
    expect(p.math_genealogy_id).toBeNull();
    expect(p.website).toBeNull();
  });

  it("coerces explicit-null wikidata arrays to [] (not null)", async () => {
    mockRun([
      {
        type: "person",
        short_id: "pnull",
        url: "https://e/pnull",
        citizenships: null,
        awards: null,
        doctoral_students: null,
        birth_year: null,
        website: null,
      },
      { type: "person_section", title: "S", short_ids: ["pnull"] },
    ]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.persons.pnull;
    expect(p.citizenships).toEqual([]);
    expect(p.awards).toEqual([]);
    expect(p.doctoral_students).toEqual([]);
    expect(p.birth_year).toBeNull();
    expect(p.website).toBeNull();
  });

  it("normalizes all-null person optionals to nulls / empty evidence", async () => {
    mockRun([
      {
        type: "person",
        short_id: "p0",
        url: "https://e/p0",
        name: null,
        affiliation: null,
        n_works: null,
        evidence: null,
      },
      { type: "person_section", title: "S", short_ids: ["p0"] },
    ]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.persons.p0;
    expect(p.name).toBe("");
    expect(p.affiliation).toBeNull();
    expect(p.n_works).toBeNull();
    expect(p.evidence).toEqual([]);
  });

  it("keeps paper sections and person sections in one run with sequential ids and mode passthrough", async () => {
    mockRun([personRaw, personSectionRaw, paperRaw, paperSectionRaw]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections.map((s) => s.id)).toEqual(["section-1", "section-2"]);
    expect(r.sections[0].kind).toBe("persons");
    expect(r.sections[1].kind).toBe("papers");
    expect(r.sections[1].mode).toBe("semantic");
    expect(r.sections[1].rows[0]).toEqual({
      handle: "RePEc:x:2",
      rank: 1,
      similarity: 0.91,
    });
    expect(Object.keys(r.papers)).toEqual(["RePEc:x:2"]);
    expect(Object.keys(r.persons)).toEqual(["pne16"]);
  });

  it("applies the refine-round idOffset to person section ids", async () => {
    mockRun([personRaw, personSectionRaw]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections[0].id).toBe("section-4");
  });

  it("forwards R progress events whose current/total were explicit nulls", async () => {
    mockRun([
      { type: "progress", label: "person_search: minimum wages…", current: null, total: null },
      personRaw,
      personSectionRaw,
    ]);
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const emitted: StreamEventPayload[] = [];
    await executeScript("x <- 1", "/fake/db.duckdb", (e) => emitted.push(e));
    const progress = emitted.filter((e) => e.type === "progress");
    expect(progress).toHaveLength(1);
    if (progress[0].type === "progress") {
      expect(progress[0].label).toMatch(/person_search/);
      expect(progress[0].current).toBeUndefined();
      expect(progress[0].total).toBeUndefined();
    }
  });

  it("returns ok:false on a non-zero exit even when persons were collected", async () => {
    mockRun([personRaw], { exitCode: 1, stderr: "boom" });
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const r = await executeScript("x <- 1", "/fake/db.duckdb", () => undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/exited with code 1/);
  });
});
