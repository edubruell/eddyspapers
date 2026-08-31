import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";
import type { Paper, Section } from "../../src/agent/types.js";

// Script-only is the DEFAULT mode of lit_search: the server runs the whole search and hands
// back the rows, and only a key carrying 'lit_search_synth' may ask it to write the review.
// These tests pin both halves of that contract — the default must never quietly start
// spending synthesis tokens, and an ungranted request must be refused rather than downgraded
// (a silent downgrade reads to the calling agent as a broken tool).

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

const paper: Paper = {
  handle: "repec:aea:aer:7",
  title: "Monopsony in the Labor Market",
  authors: ["Manning, A.", "Card, D."],
  year: 2021,
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: "https://x/7",
  doi: "10.1257/aer.7",
  abstract: "Wage setting under monopsony.",
  bibtex: "@article{manning2021,}",
  stats: { cites_internal: 4, cites_total: 42, percentile: 91 },
};

const section: Section = {
  id: "sem-1",
  title: "Semantic: monopsony",
  mode: "semantic",
  n_total: 1,
  n_shown: 1,
  rows: [{ handle: paper.handle, rank: 1, similarity: 0.2 }],
};

const scopedKey = (scopes: KeyIdentity["scopes"]): KeyIdentity => ({
  id: "scriptonly01",
  label: "t",
  scopes,
  rateLimitOverrides: null,
  tools: null,
});

let tmp: string;

async function makeClient(key: KeyIdentity | null): Promise<Client> {
  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer(key);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "scriptonly-test", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-scriptonly-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  delete process.env.AGENTIC_PASSWORD;

  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockResolvedValue({
    ok: true,
    script: "handles <- c('repec:aea:aer:7')",
    strategy: "Sweep the monopsony literature.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  });
  executeScript.mockImplementation(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: "paper", paper });
    onEvent({ type: "section", section });
    onEvent({ type: "bibtex", entries: 1, bibtex: "@article{manning2021,}" });
    return {
      ok: true,
      papers: { [paper.handle]: paper },
      persons: {},
      sections: [section],
      bibtex: "@article{manning2021,}",
    };
  });
  synthesize.mockResolvedValue("## Review\nShould never run in script-only mode.");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("lit_search — script-only is the default", () => {
  it("returns the full result set without calling the synthesiser", async () => {
    synthesize.mockClear();
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Monopsony power and wage setting in concentrated local labour markets." },
    });

    expect(res.isError).toBeFalsy();
    expect(synthesize).not.toHaveBeenCalled();

    const sc = res.structuredContent as {
      mode: string;
      synthesis_md: string;
      script: string;
      bibtex: string;
      papers_csv: string;
      papers: Record<string, unknown>;
    };
    expect(sc.mode).toBe("script_only");
    expect(sc.synthesis_md).toBe("");
    // Everything a caller needs to write the review itself is still there.
    expect(sc.script).toContain("repec:aea:aer:7");
    expect(sc.bibtex).toContain("manning2021");
    expect(sc.papers_csv.split("\n").length).toBeGreaterThan(1);
    expect(Object.keys(sc.papers)).toEqual([paper.handle]);
  });

  it("puts a citable digest of the results in the text block instead of a synthesis", async () => {
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Digest probe: wage setting under employer concentration in local markets." },
    });

    const text = JSON.stringify(res.content);
    expect(text).toMatch(/script-only/i);
    expect(text).toMatch(/Manning, A.; Card, D./); // authors semicolon-joined, as elsewhere
    expect(text).toMatch(/Monopsony in the Labor Market/);
    expect(text).toMatch(/repec:aea:aer:7/);
    expect(text).toMatch(/Sweep the monopsony literature/); // the strategy carries over
  });
});

describe("lit_search — synthesis is scope-gated", () => {
  it("refuses synthesize=true for a key without 'lit_search_synth' and never runs the pipeline", async () => {
    writeScript.mockClear();
    synthesize.mockClear();
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Refusal probe: minimum wages and employment in monopsonistic markets.", synthesize: true },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/lit_search_synth/);
    // Refused up front — no script written, no tokens spent on a request we won't complete.
    expect(writeScript).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("synthesises for a key that carries 'lit_search_synth'", async () => {
    synthesize.mockClear();
    synthesize.mockImplementation(async (...a: unknown[]) => {
      const onDelta = a.filter((x) => typeof x === "function").at(-1) as (d: string) => void;
      onDelta("## Review\nMonopsony lowers wages below marginal product.");
      return "## Review\nMonopsony lowers wages below marginal product.";
    });
    const client = await makeClient(scopedKey(["mcp", "lit_search", "lit_search_synth"]));
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Granted probe: employer concentration and wage markdowns across regions.", synthesize: true },
    });

    expect(res.isError).toBeFalsy();
    expect(synthesize).toHaveBeenCalledTimes(1);
    const sc = res.structuredContent as { mode: string; synthesis_md: string };
    expect(sc.mode).toBe("synthesis");
    expect(sc.synthesis_md).toMatch(/marginal product/);
  });

  it("treats a null key (gate disabled, e.g. local stdio) as granted", async () => {
    synthesize.mockClear();
    const client = await makeClient(null);
    const res = await client.callTool({
      name: "lit_search",
      arguments: { brief: "Dev probe: labour market power and the wage distribution over time.", synthesize: true },
    });
    expect(res.isError).toBeFalsy();
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});
