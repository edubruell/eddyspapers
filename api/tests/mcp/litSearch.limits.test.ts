import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";
import type { Paper, Section } from "../../src/agent/types.js";

// lit_search under an authenticated key: the 'lit_search' scope check and the per-key
// single-concurrent cap (PLAN.md §D1). Pipeline stages are mocked — no live LLM/R/Ollama.

const clarify = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();
const synthesize = vi.fn();
const assess = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({ clarify: (...a: unknown[]) => clarify(...a) }));
vi.mock("../../src/agent/stages/writeScript.js", () => ({ writeScript: (...a: unknown[]) => writeScript(...a) }));
vi.mock("../../src/agent/stages/execute.js", () => ({ executeScript: (...a: unknown[]) => executeScript(...a) }));
vi.mock("../../src/agent/stages/synthesize.js", () => ({ synthesize: (...a: unknown[]) => synthesize(...a) }));
vi.mock("../../src/agent/stages/assess.js", () => ({ assess: (...a: unknown[]) => assess(...a), summarizeResult: () => "" }));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const paper: Paper = {
  handle: "repec:aea:aer:1",
  title: "Minimum Wage and Employment",
  authors: ["Smith, A."],
  year: 2020,
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: "https://x/1",
  abstract: "We study minimum wages.",
  bibtex: "@article{smith2020,}",
};
const section: Section = {
  id: "sem-1",
  title: "Semantic",
  mode: "semantic",
  n_total: 1,
  n_shown: 1,
  rows: [{ handle: paper.handle, rank: 1, similarity: 0.18 }],
};

// A synth gate we can hold open to keep one run in-flight (to observe the concurrency cap).
let releaseSynth: () => void = () => undefined;
function armPipeline(gateSynth: boolean): void {
  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockResolvedValue({ ok: true, script: "handles <- c('repec:aea:aer:1')", strategy: "S", attempts: 1, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 } });
  executeScript.mockImplementation(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: "section", section });
    return { ok: true, papers: { [paper.handle]: paper }, persons: {}, sections: [section], bibtex: "@article{smith2020,}" };
  });
  synthesize.mockImplementation(async (..._a: unknown[]) => {
    if (gateSynth) await new Promise<void>((r) => (releaseSynth = r));
    const onDelta = _a[6] as (d: string) => void;
    onDelta("## Review\nDone.");
    return "## Review\nDone.";
  });
}

async function makeClient(key: KeyIdentity | null): Promise<Client> {
  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer(key);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

const scopedKey = (scopes: KeyIdentity["scopes"]): KeyIdentity => ({ id: "testkey01", label: "t", scopes, rateLimitOverrides: null });

let tmp: string;

beforeEach(async () => {
  vi.resetModules();
  tmp = await mkdtemp(join(tmpdir(), "agentic-litlim-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  delete process.env.AGENTIC_PASSWORD;
  const { getRateLimiter } = await import("../../src/auth/rateLimit.js");
  getRateLimiter().reset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("lit_search — scoped-key enforcement", () => {
  it("fails a key without the 'lit_search' scope before running the pipeline", async () => {
    armPipeline(false);
    const client = await makeClient(scopedKey(["rest", "mcp"]));
    const res = await client.callTool({ name: "lit_search", arguments: { brief: "minimum wage employment effects across US states" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/lit_search.*scope/i);
    expect(writeScript).not.toHaveBeenCalled();
  });

  it("runs for a key that carries the 'lit_search' scope", async () => {
    armPipeline(false);
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await client.callTool({ name: "lit_search", arguments: { brief: "monopsony and the minimum wage in low-wage labour markets" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { synthesis_md: string }).synthesis_md).toMatch(/Done/);
  });

  it("a cache HIT does not consume lit_search quota (identical brief served free at concurrency=1)", async () => {
    writeScript.mockClear(); // isolate the call count from earlier tests in this file
    armPipeline(false);
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const brief = "cache probe brief about wage compression in low pay sectors";

    // First run executes the pipeline and finalizes as `done` in the store.
    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(first.isError).toBeFalsy();
    expect(writeScript).toHaveBeenCalledTimes(1);

    // Occupy the single concurrency slot with an UNRELATED in-flight key so that, were the
    // cache path to consult the limiter, the identical re-run would be blocked.
    const { getRateLimiter } = await import("../../src/auth/rateLimit.js");
    const acquired = getRateLimiter().tryAcquire("testkey01", "lit_search");
    expect(acquired.ok).toBe(true); // slot now held

    // Identical brief → cache hit, rebuilt from stored events, no pipeline, no limiter.
    const second = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(second.isError).toBeFalsy();
    expect((second.structuredContent as { synthesis_md: string }).synthesis_md).toMatch(/Done/);
    expect(writeScript).toHaveBeenCalledTimes(1); // pipeline did NOT run again
  });

  it("rejects a second concurrent run for the same key (1-concurrent cap)", async () => {
    armPipeline(true); // hold synth open so the first run keeps its slot
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));

    const first = client.callTool({ name: "lit_search", arguments: { brief: "first distinct brief about wage inequality dynamics" } });
    // Let the first run advance into its (gated) synth stage and claim the slot.
    await new Promise((r) => setTimeout(r, 50));
    const second = await client.callTool({ name: "lit_search", arguments: { brief: "second distinct brief about labour market monopsony" } });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toMatch(/concurrent/i);

    releaseSynth();
    const firstRes = await first;
    expect(firstRes.isError).toBeFalsy();
  });
});
