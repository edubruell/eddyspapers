import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Paper, Section } from "../../src/agent/types.js";

// End-to-end lit_search tool tests with the pipeline stages mocked (no live LLM / R /
// Ollama) — the same hermetic pattern as tests/agent/runAgent.clarify.test.ts. Drives a
// real MCP Client over an in-memory transport so the tool contract (structuredContent,
// cache, needs_clarification, progress notifications) is exercised exactly as a coding
// agent would see it.

const clarify = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();
const synthesize = vi.fn();
const assess = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({ clarify: (...a: unknown[]) => clarify(...a) }));
vi.mock("../../src/agent/stages/writeScript.js", () => ({ writeScript: (...a: unknown[]) => writeScript(...a) }));
vi.mock("../../src/agent/stages/execute.js", () => ({ executeScript: (...a: unknown[]) => executeScript(...a) }));
vi.mock("../../src/agent/stages/synthesize.js", () => ({ synthesize: (...a: unknown[]) => synthesize(...a) }));
vi.mock("../../src/agent/stages/assess.js", () => ({
  assess: (...a: unknown[]) => assess(...a),
  summarizeResult: () => "",
}));
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
  stats: { cites_internal: 5, cites_total: 60, percentile: 88 },
};

const section: Section = {
  id: "sem-1",
  title: "Semantic: minimum wage",
  mode: "semantic",
  n_total: 1,
  n_shown: 1,
  rows: [{ handle: paper.handle, rank: 1, similarity: 0.18 }],
};

// Default happy-path behaviour: clarifier proceeds, one round produces one paper + synthesis.
function setHappyPath(): void {
  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockResolvedValue({
    ok: true,
    script: "handles <- c('repec:aea:aer:1')",
    strategy: "Semantic sweep of the minimum-wage literature.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  });
  executeScript.mockImplementation(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: "paper", paper });
    onEvent({ type: "section", section });
    onEvent({ type: "bibtex", entries: 1, bibtex: "@article{smith2020,}" });
    return { ok: true, papers: { [paper.handle]: paper }, persons: {}, sections: [section], bibtex: "@article{smith2020,}" };
  });
  synthesize.mockImplementation(async (..._a: unknown[]) => {
    const onDelta = _a.filter((x) => typeof x === "function").at(-1) as (d: string) => void;
    onDelta("## Review\n");
    onDelta("Minimum wages have small disemployment effects.");
    return "## Review\nMinimum wages have small disemployment effects.";
  });
}

let client: Client;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-litsearch-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  delete process.env.AGENTIC_PASSWORD;
  setHappyPath();

  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "litsearch-test", version: "1.0.0" });
  await client.connect(clientT);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("lit_search — tool listing", () => {
  it("advertises the fat pipeline tool with the documented inputs", async () => {
    const { tools } = await client.listTools();
    const lit = tools.find((t) => t.name === "lit_search");
    expect(lit).toBeDefined();
    expect(Object.keys(lit?.inputSchema?.properties ?? {}).sort()).toEqual(
      ["brief", "categories", "min_year", "must_include", "refine", "skip_clarify"].sort(),
    );
    expect(lit?.inputSchema?.required).toContain("brief");
    expect(lit?.description).toMatch(/cached/i);
  });
});

describe("lit_search — happy path", () => {
  it("returns the §7.5 three-artifact bundle from one call", async () => {
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Causal effects of minimum wage on low-wage employment across US states." },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.synthesis_md).toMatch(/Minimum wages have small/);
    expect(sc.bibtex).toContain("@article{smith2020,}");
    expect(sc.strategy).toMatch(/Semantic sweep/);
    expect(sc.script).toContain("handles");
    expect(sc.papers).toHaveProperty(paper.handle);
    expect(sc.resource_uri).toBe(`agenticsearch://searches/${sc.search_id as string}`);
    expect((sc.suggested_paths as { report: string }).report).toMatch(/^local_context\/notes\/literature\/lit_/);
    // CSV: header + one paper row carrying the best similarity and stats.
    const csv = sc.papers_csv as string;
    expect(csv.split("\n")[0]).toMatch(/^handle,title,authors/);
    expect(csv).toContain("0.18");
    expect(csv).toContain("88");
    // The text block carries the synthesis so text-only clients still get the review.
    const text = (res.content as { type: string; text: string }[])[0];
    expect(text.text).toMatch(/Minimum wages/);
  });
});

describe("lit_search — caching (§7.8)", () => {
  it("serves an identical brief from the store without re-running the pipeline", async () => {
    const brief = "Household portfolio choice under background labour-income risk.";
    writeScript.mockClear();
    executeScript.mockClear();
    synthesize.mockClear();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(first.isError).toBeFalsy();
    expect(writeScript).toHaveBeenCalledTimes(1);
    const firstId = (first.structuredContent as { search_id: string }).search_id;

    const second = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(second.isError).toBeFalsy();
    // No new pipeline work on the repeat call — the run came back from cache.
    expect(writeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((second.structuredContent as { search_id: string }).search_id).toBe(firstId);
    expect((second.structuredContent as { synthesis_md: string }).synthesis_md).toMatch(/Minimum wages/);
  });
});

describe("lit_search — needs_clarification (§7.3)", () => {
  it("returns structured questions (not an error, not a hang) when skip_clarify is false", async () => {
    clarify.mockResolvedValueOnce({
      action: "question",
      question: "Which country or region?",
      options: ["US", "Europe", "Global"],
    });
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "wage effects", skip_clarify: false },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { needs_clarification?: { question: string; options: string[] } };
    expect(sc.needs_clarification?.question).toBe("Which country or region?");
    expect(sc.needs_clarification?.options).toEqual(["US", "Europe", "Global"]);
    // The pipeline stopped at clarify — no script was written.
    expect((res.content as { text: string }[])[0].text).toMatch(/re-invoke/i);
  });

  it("does not block when skip_clarify defaults true even if the clarifier would ask", async () => {
    clarify.mockResolvedValueOnce({ action: "question", question: "narrow it?", options: [] });
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Search frictions in online labour markets and matching efficiency." },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toHaveProperty("needs_clarification");
    expect((res.structuredContent as { synthesis_md: string }).synthesis_md).toMatch(/Minimum wages/);
  });
});

describe("lit_search — failure surfaces as an error result", () => {
  it("reports a rejected brief as isError", async () => {
    clarify.mockResolvedValueOnce({ action: "reject", reason: "This is not a research topic." });
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "asdfghjkl", skip_clarify: false },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/not a research topic/i);
  });
});

describe("lit_search — progress notifications (§7.4)", () => {
  it("streams stage progress when the caller attaches a progressToken", async () => {
    const seen: { progress: number; total?: number; message?: string }[] = [];
    const res = await client.callTool(
      { name: "lit_search", arguments: { brief: "Returns to schooling identified from compulsory-schooling reforms." } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(res.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.total === 5)).toBe(true);
    const messages = seen.map((p) => p.message ?? "").join("\n");
    expect(messages).toMatch(/script|synthesis|Strategy|Section/i);
  });

  it("keeps the progress step within 1..5 and non-decreasing across the run", async () => {
    setHappyPath();
    const seen: { progress: number; total?: number }[] = [];
    const res = await client.callTool(
      { name: "lit_search", arguments: { brief: "Monetary policy transmission through bank lending in the euro area." } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(res.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.progress >= 1 && p.progress <= 5)).toBe(true);
    expect(seen.every((p) => p.total === 5)).toBe(true);
    // progress derives from the stage step, which only advances → monotonic non-decreasing
    const steps = seen.map((p) => p.progress);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    // the synthesize stage (step 5) must have been reached on a completed run
    expect(Math.max(...steps)).toBe(5);
  });
});

// ── Additional edge cases (Phase 3 test extension) ─────────────────────────────────────
describe("lit_search — cache-key sensitivity (§7.8, PLAN §12.4)", () => {
  it("gives DIFFERENT categories DIFFERENT search_ids and re-runs (no collision)", async () => {
    setHappyPath();
    writeScript.mockClear();
    const brief = "Trade liberalisation and local labour-market adjustment.";
    const a = await client.callTool({ name: "lit_search", arguments: { brief, categories: ["Top 5 Journals"] } });
    const b = await client.callTool({ name: "lit_search", arguments: { brief, categories: ["Labour"] } });
    const idA = (a.structuredContent as { search_id: string }).search_id;
    const idB = (b.structuredContent as { search_id: string }).search_id;
    expect(idA).not.toBe(idB);
    // both were fresh runs — neither served the other from cache
    expect(writeScript).toHaveBeenCalledTimes(2);
  });

  it("gives DIFFERENT min_year DIFFERENT search_ids and re-runs", async () => {
    setHappyPath();
    writeScript.mockClear();
    const brief = "Firm-level productivity dispersion within narrow industries.";
    const a = await client.callTool({ name: "lit_search", arguments: { brief, min_year: 2000 } });
    const b = await client.callTool({ name: "lit_search", arguments: { brief, min_year: 2015 } });
    const idA = (a.structuredContent as { search_id: string }).search_id;
    const idB = (b.structuredContent as { search_id: string }).search_id;
    expect(idA).not.toBe(idB);
    expect(writeScript).toHaveBeenCalledTimes(2);
  });

  it("does NOT serve a prior ERRORED run from cache (only status done is cacheable)", async () => {
    const brief = "Not-actually-a-topic brief that will fail the first time only.";
    // first call: the clarifier hard-rejects → error result, persisted as status=error
    clarify.mockResolvedValueOnce({ action: "reject", reason: "This is not a research topic." });
    const first = await client.callTool({ name: "lit_search", arguments: { brief, skip_clarify: false } });
    expect(first.isError).toBe(true);

    // second call, identical inputs: the error run must NOT be replayed from cache — the
    // pipeline re-runs. Restore the happy path and confirm a real synthesis comes back.
    setHappyPath();
    writeScript.mockClear();
    const second = await client.callTool({ name: "lit_search", arguments: { brief, skip_clarify: false } });
    expect(second.isError).toBeFalsy();
    expect(writeScript).toHaveBeenCalledTimes(1); // re-ran, not cache-served
    expect((second.structuredContent as { synthesis_md: string }).synthesis_md).toMatch(/Minimum wages/);
  });
});

describe("lit_search — input threading", () => {
  it("threads must_include, categories, and min_year into the writer's AgentInput", async () => {
    setHappyPath();
    writeScript.mockClear();
    await client.callTool({
      name: "lit_search",
      arguments: {
        brief: "Search-and-matching models of unemployment with on-the-job search.",
        categories: ["Macro"],
        min_year: 2010,
        must_include: ["Mortensen, D.", "Pissarides, C."],
      },
    });
    expect(writeScript).toHaveBeenCalledTimes(1);
    // writeScript is called with a single opts object carrying the filter fields (runAgent.ts).
    const opts = writeScript.mock.calls[0][0] as {
      categories?: string[];
      minYear?: number;
      mustInclude?: string[];
    };
    expect(opts.categories).toEqual(["Macro"]);
    expect(opts.minYear).toBe(2010);
    expect(opts.mustInclude).toEqual(["Mortensen, D.", "Pissarides, C."]);
  });

  it("runs the refine advisor only when refine=true (flag reaches the agent)", async () => {
    setHappyPath();
    assess.mockClear();
    // refine off (default): the assessor is never consulted.
    await client.callTool({
      name: "lit_search",
      arguments: { brief: "Wealth inequality dynamics under heterogeneous returns, baseline." },
    });
    expect(assess).not.toHaveBeenCalled();

    // refine on: exactly one assessment pass runs. Returning null (advisor "failure")
    // proves the assessor was consulted without triggering a full second round.
    assess.mockResolvedValueOnce(null);
    await client.callTool({
      name: "lit_search",
      arguments: { brief: "Wealth inequality dynamics under heterogeneous returns, refined.", refine: true },
    });
    expect(assess).toHaveBeenCalledTimes(1);
  });
});

describe("lit_search — empty results", () => {
  it("returns a terminal (non-error) bundle with a header-only CSV when a run yields zero papers", async () => {
    clarify.mockResolvedValue({ action: "proceed" });
    writeScript.mockResolvedValue({
      ok: true,
      script: "handles <- character(0)",
      strategy: "Broad sweep that found nothing.",
      attempts: 1,
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    executeScript.mockImplementation(async () => ({
      ok: true,
      papers: {},
      persons: {},
      sections: [],
      bibtex: "",
    }));
    synthesize.mockClear();

    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "An extremely narrow topic with no corpus coverage whatsoever xyzzy." },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { papers_csv: string; papers: Record<string, unknown>; synthesis_md: string };
    expect(Object.keys(sc.papers)).toEqual([]);
    expect(sc.papers_csv.split("\n")).toHaveLength(1); // header only
    expect(sc.papers_csv).toMatch(/^handle,title,authors/);
    // Product behaviour (runAgent.ts §synthesize): a zero-result run short-circuits the
    // synthesiser and emits a placeholder — still a terminal, non-error bundle.
    expect(synthesize).not.toHaveBeenCalled();
    expect(sc.synthesis_md).toMatch(/No results were returned/i);

    setHappyPath(); // restore for any later tests
  });
});
