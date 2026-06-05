import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../../src/agent/types.js";

// Hermetic runAgent happy-path test: every stage is mocked, so there is no live
// LLM, no R sandbox, and no DuckDB. We assert that runAgent emits a `strategy`
// StreamEvent and that it is a well-formed member of the event taxonomy.

vi.mock("../../src/agent/stages/clarify.js", () => ({
  clarify: vi.fn(async () => ({ action: "proceed" })),
}));
vi.mock("../../src/agent/stages/writeScript.js", () => ({
  writeScript: vi.fn(async () => ({
    ok: true,
    script: "all_handles <- character(0)\nemit_bibtex(all_handles)",
    strategy: "I'll sweep the top journals for well-cited minimum-wage work, then add recent working papers.",
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

describe("runAgent strategy emission (happy path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits exactly one strategy event that is a valid StreamEvent variant", async () => {
    const { runAgent } = await import("../../src/agent/runAgent.js");

    const events: StreamEvent[] = [];
    await runAgent("s1", { brief: "employment effects of minimum wages in Germany" }, "/fake/db.duckdb", (e) =>
      events.push(e),
    );

    const strategyEvents = events.filter((e) => e.type === "strategy");
    expect(strategyEvents).toHaveLength(1);

    const strat = strategyEvents[0];
    expect(strat.type).toBe("strategy");
    expect(typeof strat.seq).toBe("number");
    if (strat.type === "strategy") {
      expect(strat.strategy).toContain("top journals");
      // strategy variant never carries a stage field
      expect("stage" in strat).toBe(false);
    }
  });

  it("emits strategy after the write stage entered and before the script event", async () => {
    const { runAgent } = await import("../../src/agent/runAgent.js");

    const events: StreamEvent[] = [];
    await runAgent("s2", { brief: "employment effects of minimum wages in Germany" }, "/fake/db.duckdb", (e) =>
      events.push(e),
    );

    const writeEnterIdx = events.findIndex(
      (e) => e.type === "stage" && e.stage === "write" && e.state === "enter",
    );
    const strategyIdx = events.findIndex((e) => e.type === "strategy");
    const scriptIdx = events.findIndex((e) => e.type === "script");

    expect(writeEnterIdx).toBeGreaterThanOrEqual(0);
    expect(strategyIdx).toBeGreaterThan(writeEnterIdx);
    expect(scriptIdx).toBeGreaterThan(strategyIdx);
  });

  it("assigns monotonically increasing seq numbers across all emitted events", async () => {
    const { runAgent } = await import("../../src/agent/runAgent.js");

    const events: StreamEvent[] = [];
    await runAgent("s3", { brief: "employment effects of minimum wages in Germany" }, "/fake/db.duckdb", (e) =>
      events.push(e),
    );

    const seqs = events.map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
