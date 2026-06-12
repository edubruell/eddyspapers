import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Person, StreamEvent } from "../../src/agent/types.js";

// Hermetic tests for person threading through runAgent (mock pattern follows
// runAgent.refine.test.ts): a person-only run must synthesize (not short-circuit to the
// "_No results_" placeholder), refine merges/replaces persons alongside papers, and the
// round-2 failure guard treats persons as results worth keeping.

const assess = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();
const synthesize = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({
  clarify: vi.fn(async () => ({ action: "proceed" })),
}));
vi.mock("../../src/agent/stages/writeScript.js", () => ({
  writeScript: (...a: unknown[]) => writeScript(...a),
}));
vi.mock("../../src/agent/stages/execute.js", () => ({
  executeScript: (...a: unknown[]) => executeScript(...a),
}));
vi.mock("../../src/agent/stages/assess.js", async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, assess: (...a: unknown[]) => assess(...a) };
});
vi.mock("../../src/agent/stages/synthesize.js", () => ({
  synthesize: (...a: unknown[]) => synthesize(...a),
}));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const brief = "who are the leading researchers on minimum wages?";

function mkPerson(short_id: string): Person {
  return {
    short_id,
    name: `Name ${short_id}`,
    affiliation: "Inst",
    homepage: null,
    image_url: null,
    wikipedia_url: null,
    orcid: null,
    url: `https://ideas.repec.org/e/${short_id}.html`,
    n_works: 5,
    citations: 50,
    first_year: 2010,
    last_year: 2026,
    primary_category: "C",
    n_matched: 2,
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
  };
}

function mkPaper(handle: string) {
  return {
    handle,
    title: `T ${handle}`,
    authors: ["A"],
    year: 2021,
    journal: "J",
    category: "C",
    url: "",
    abstract: null,
    bibtex: "",
  };
}

function mkPersonSection(id: string, title: string, shortIds: string[]) {
  return {
    id,
    title,
    mode: "person" as const,
    kind: "persons" as const,
    n_total: shortIds.length,
    n_shown: shortIds.length,
    rows: shortIds.map((s, i) => ({ handle: s, rank: i + 1 })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeScript.mockImplementation(async (opts: { revision?: unknown }) => ({
    ok: true,
    script: opts.revision ? "ROUND2_SCRIPT" : "ROUND1_SCRIPT",
    strategy: opts.revision ? "Refined plan." : "Initial plan.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  }));
  synthesize.mockImplementation(
    async (...a: unknown[]) => {
      const onDelta = a[6] as (d: string) => void;
      onDelta("## Who to talk to");
      return "## Who to talk to";
    },
  );
});

describe("runAgent — person-only synthesis guard", () => {
  it("synthesizes when the run returned persons but zero papers", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: {},
      persons: { p1: mkPerson("p1"), p2: mkPerson("p2") },
      sections: [mkPersonSection("section-1", "People", ["p1", "p2"])],
      bibtex: "",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const r = await runAgent("p-only", { brief }, "/fake/db.duckdb", (e) => events.push(e));

    expect(r.paused).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(1);
    // persons threaded into the synthesizer (5th positional arg)
    const personsArg = synthesize.mock.calls[0][4] as Record<string, Person>;
    expect(Object.keys(personsArg)).toEqual(["p1", "p2"]);

    const synthDeltas = events.filter((e) => e.type === "synthesis");
    expect(synthDeltas.length).toBeGreaterThan(0);
    expect(synthDeltas.some((e) => e.type === "synthesis" && /No results/.test(e.delta))).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("still emits the no-results placeholder when papers AND persons are empty", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: {},
      persons: {},
      sections: [],
      bibtex: "",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("empty", { brief }, "/fake/db.duckdb", (e) => events.push(e));

    expect(synthesize).not.toHaveBeenCalled();
    expect(
      events.some((e) => e.type === "synthesis" && /No results/.test(e.delta)),
    ).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("tolerates an executeScript result without a persons key (legacy shape)", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: { a: mkPaper("a") },
      sections: [],
      bibtex: "",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("legacy", { brief }, "/fake/db.duckdb", (e) => events.push(e));

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0][4]).toEqual({});
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

describe("runAgent — persons through the refine pass", () => {
  it("augment unions persons by short_id across rounds", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: {},
        persons: { p1: mkPerson("p1"), p2: mkPerson("p2") },
        sections: [mkPersonSection("section-1", "People", ["p1", "p2"])],
        bibtex: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: {},
        persons: { p2: mkPerson("p2"), p3: mkPerson("p3") },
        sections: [mkPersonSection("section-2", "More people", ["p2", "p3"])],
        bibtex: "",
      });
    assess.mockResolvedValue({
      reason: "Broadening the field.",
      directive: "Re-run with a wider framing.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("p-aug", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(executeScript).toHaveBeenCalledTimes(2);
    const personsArg = synthesize.mock.calls[0][4] as Record<string, Person>;
    expect(Object.keys(personsArg).sort()).toEqual(["p1", "p2", "p3"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("replace discards round-1 persons", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: {},
        persons: { p1: mkPerson("p1") },
        sections: [mkPersonSection("section-1", "People", ["p1"])],
        bibtex: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: {},
        persons: { p9: mkPerson("p9") },
        sections: [mkPersonSection("section-1", "Corrected people", ["p9"])],
        bibtex: "",
      });
    assess.mockResolvedValue({
      reason: "Wrong framing.",
      directive: "Redo with the right topic.",
      mode: "replace",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("p-rep", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));

    const personsArg = synthesize.mock.calls[0][4] as Record<string, Person>;
    expect(Object.keys(personsArg)).toEqual(["p9"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("a failed augment round 2 is NOT fatal when round 1 returned only persons", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: {},
        persons: { p1: mkPerson("p1") },
        sections: [mkPersonSection("section-1", "People", ["p1"])],
        bibtex: "",
      })
      .mockResolvedValueOnce({ ok: false, message: "boom", timedOut: false });
    assess.mockResolvedValue({
      reason: "Trying more.",
      directive: "Add papers.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("p-fail2", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));

    // Person results count as something to fall back to — degrade, don't fail.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const personsArg = synthesize.mock.calls[0][4] as Record<string, Person>;
    expect(Object.keys(personsArg)).toEqual(["p1"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("assess receives the round-1 persons", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: {},
      persons: { p1: mkPerson("p1") },
      sections: [mkPersonSection("section-1", "People", ["p1"])],
      bibtex: "",
    });
    assess.mockResolvedValue(null);
    const { runAgent } = await import("../../src/agent/runAgent.js");
    await runAgent("p-assess", { brief, refine: true }, "/fake/db.duckdb", () => undefined);

    expect(assess).toHaveBeenCalledTimes(1);
    const arg = assess.mock.calls[0][0] as { persons?: Record<string, Person> };
    expect(Object.keys(arg.persons ?? {})).toEqual(["p1"]);
  });
});
