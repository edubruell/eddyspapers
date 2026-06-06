import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../../src/agent/types.js";

// Hermetic two-phase clarifier tests for runAgent. clarify is a per-test mock;
// the downstream stages are stubbed so there is no live LLM / R sandbox / DuckDB.

const clarify = vi.fn();
vi.mock("../../src/agent/stages/clarify.js", () => ({
  clarify: (...args: unknown[]) => clarify(...args),
}));
vi.mock("../../src/agent/stages/writeScript.js", () => ({
  writeScript: vi.fn(async () => ({
    ok: true,
    script: "all_handles <- character(0)\nemit_bibtex(all_handles)",
    strategy: "I'll sweep the top journals, then add recent working papers.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  })),
}));
vi.mock("../../src/agent/stages/execute.js", () => ({
  executeScript: vi.fn(async () => ({
    ok: true,
    papers: { "repec:x:1": { handle: "repec:x:1" } },
    sections: [],
    bibtex: "@article{x,}",
  })),
}));
vi.mock("../../src/agent/stages/synthesize.js", () => ({
  synthesize: vi.fn(async () => "## Findings"),
}));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const brief = "recent top-5 labour papers and their unique selling point";

describe("runAgent clarifier — Phase A (start)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pauses on a question when skipClarify is not set: returns paused, emits clarify, no done", async () => {
    clarify.mockResolvedValue({
      action: "question",
      question: "USP relative to what?",
      options: ["Method", "Data", "New question"],
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const result = await runAgent("s1", { brief }, "/fake/db.duckdb", (e) => events.push(e));

    expect(result.paused).toBe(true);

    const clarifyEvents = events.filter((e) => e.type === "clarify");
    expect(clarifyEvents).toHaveLength(1);
    const ev = clarifyEvents[0];
    if (ev.type === "clarify") {
      expect(ev.question).toBe("USP relative to what?");
      expect(ev.options).toEqual(["Method", "Data", "New question"]);
      expect(ev.required).toBe(true);
    }

    // No terminal event and no clarify stage-exit while paused.
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(
      events.some((e) => e.type === "stage" && e.stage === "clarify" && e.state === "exit"),
    ).toBe(false);
    // It must not have proceeded to write.
    expect(events.some((e) => e.type === "stage" && e.stage === "write")).toBe(false);
  });

  it("does NOT pause when skipClarify=true even if the model returns a question", async () => {
    clarify.mockResolvedValue({
      action: "question",
      question: "USP relative to what?",
      options: ["Method", "Data"],
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const result = await runAgent("s2", { brief, skipClarify: true }, "/fake/db.duckdb", (e) =>
      events.push(e),
    );

    expect(result.paused).toBe(false);
    expect(events.some((e) => e.type === "clarify")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
    // clarify stage opened AND closed in one pass.
    expect(
      events.some((e) => e.type === "stage" && e.stage === "clarify" && e.state === "exit"),
    ).toBe(true);
  });

  it("rejects an off-topic brief: fail + done, never paused, never reaches write", async () => {
    clarify.mockResolvedValue({ action: "reject", reason: "This service searches economics papers." });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const result = await runAgent("s3", { brief: "how do I bake sourdough" }, "/fake/db.duckdb", (e) =>
      events.push(e),
    );

    expect(result.paused).toBe(false);
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    if (errs[0].type === "error") {
      expect(errs[0].where).toBe("clarify");
      expect(errs[0].message).toMatch(/economics/);
    }
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "stage" && e.stage === "write")).toBe(false);
  });

  it("proceeds straight through when the model returns proceed", async () => {
    clarify.mockResolvedValue({ action: "proceed" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const result = await runAgent("s4", { brief }, "/fake/db.duckdb", (e) => events.push(e));

    expect(result.paused).toBe(false);
    expect(events.some((e) => e.type === "clarify")).toBe(false);
    expect(events.some((e) => e.type === "strategy")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

describe("runAgent clarifier — Phase B (resume) seq continuity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not re-run clarify, emits a clarify stage-exit first, then write…done", async () => {
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const result = await runAgent(
      "s5",
      { brief, clarifyQuestion: "USP relative to what?", clarifyAnswer: "Method" },
      "/fake/db.duckdb",
      (e) => events.push(e),
      { startSeq: 7, runClarify: false },
    );

    expect(result.paused).toBe(false);
    // clarify was NOT invoked on the resume pass.
    expect(clarify).not.toHaveBeenCalled();

    // The very first emitted event closes the clarify stage that paused.
    expect(events[0].type).toBe("stage");
    if (events[0].type === "stage") {
      expect(events[0].stage).toBe("clarify");
      expect(events[0].state).toBe("exit");
    }

    expect(events.some((e) => e.type === "strategy")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("continues seq numbering from startSeq (replay-by-seq contract holds across the pause)", async () => {
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const startSeq = 7;
    await runAgent(
      "s6",
      { brief, clarifyQuestion: "Q?", clarifyAnswer: "A" },
      "/fake/db.duckdb",
      (e) => events.push(e),
      { startSeq, runClarify: false },
    );

    const seqs = events.map((e) => e.seq);
    expect(seqs[0]).toBe(startSeq);
    // strictly monotonic, contiguous from startSeq
    seqs.forEach((s, i) => expect(s).toBe(startSeq + i));
  });
});
