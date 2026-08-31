import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../../src/agent/types.js";

// Synthesis is opt-in (AgentInput.synthesize). A script-only run must not call the
// synthesiser at all AND must not emit a synthesize stage event — the web stepper would
// otherwise park forever on a step that never exits.

const clarify = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();
const synthesize = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({ clarify: (...a: unknown[]) => clarify(...a) }));
vi.mock("../../src/agent/stages/writeScript.js", () => ({ writeScript: (...a: unknown[]) => writeScript(...a) }));
vi.mock("../../src/agent/stages/execute.js", () => ({ executeScript: (...a: unknown[]) => executeScript(...a) }));
vi.mock("../../src/agent/stages/synthesize.js", () => ({ synthesize: (...a: unknown[]) => synthesize(...a) }));
vi.mock("../../src/agent/stages/assess.js", () => ({ assess: vi.fn(), summarizeResult: () => "" }));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const paper = {
  handle: "repec:x:1",
  title: "A Paper",
  authors: ["Doe, J."],
  year: 2020,
  journal: "J",
  category: "Labour",
  url: "u",
  doi: null,
  abstract: null,
  bibtex: "@article{doe2020,}",
};

const brief = "Employer concentration and wage setting in local labour markets over time.";

beforeEach(() => {
  vi.clearAllMocks();
  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockResolvedValue({
    ok: true,
    script: "x <- 1",
    strategy: "s",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  });
  executeScript.mockResolvedValue({
    ok: true,
    papers: { [paper.handle]: paper },
    persons: {},
    sections: [],
    bibtex: "@article{doe2020,}",
  });
  synthesize.mockResolvedValue("## Review");
});

async function run(synth: boolean | undefined): Promise<StreamEvent[]> {
  const { runAgent } = await import("../../src/agent/runAgent.js");
  const events: StreamEvent[] = [];
  await runAgent("id", { brief, synthesize: synth }, "/fake/db.duckdb", (e) => events.push(e));
  return events;
}

describe("runAgent — synthesis is opt-in", () => {
  it("skips the synthesiser and the synthesize stage when synthesize is false", async () => {
    const events = await run(false);
    expect(synthesize).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "stage" && e.stage === "synthesize")).toBe(false);
    expect(events.some((e) => e.type === "synthesis")).toBe(false);
    // The run still terminates cleanly with its results.
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "script")).toBe(true);
  });

  it("defaults to script-only when synthesize is omitted", async () => {
    const events = await run(undefined);
    expect(synthesize).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("runs the synthesiser and its stage when synthesize is true", async () => {
    const events = await run(true);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "stage" && e.stage === "synthesize")).toHaveLength(2);
  });
});

describe("computeSearchId — mode is part of the cache key", () => {
  it("gives a script-only and a synthesised run of the same brief different ids", async () => {
    const { computeSearchId } = await import("../../src/agent/cache.js");
    const base = { brief, dbSnapshotDate: "2026-08-31" };
    expect(computeSearchId({ ...base, synthesize: false })).not.toBe(
      computeSearchId({ ...base, synthesize: true }),
    );
  });
});
