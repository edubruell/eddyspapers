import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";
import type { Paper, Section } from "../../src/agent/types.js";

// Handle-plus-fetch delivery. A 40-paper script-only run measured 133,641 chars and blew a
// real client's per-result cap, so a large run must come back as a handle and the artifacts
// must stay reachable by id. These tests pin both halves: what a big run withholds, and that
// fetch_search hands the withheld parts back.

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

// Fat enough that 60 of them clear the inline budget, the way real abstracts do.
const ABSTRACT = "Wage setting under monopsony. ".repeat(80);
const N_PAPERS = 60;

const paper = (n: number): Paper => ({
  handle: `repec:aea:aer:${n}`,
  title: `Monopsony ${n}`,
  authors: ["Manning, A.", "Card, D."],
  year: 2000 + (n % 20),
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: `https://x/${n}`,
  doi: `10.1257/aer.${n}`,
  abstract: ABSTRACT,
  bibtex: `@article{manning${n},\n  title = {Monopsony ${n}},\n}`,
  stats: { cites_internal: n, cites_total: n * 3, percentile: 90 },
});

const papers = Object.fromEntries(Array.from({ length: N_PAPERS }, (_, i) => [`repec:aea:aer:${i}`, paper(i)]));

const section: Section = {
  id: "sem-1",
  title: "Semantic: monopsony",
  mode: "semantic",
  n_total: N_PAPERS,
  n_shown: N_PAPERS,
  rows: Object.keys(papers).map((handle, i) => ({ handle, rank: i + 1, similarity: 0.1 })),
};

const bibtex = Object.values(papers)
  .map((p) => p.bibtex)
  .join("\n\n");

const scopedKey = (scopes: KeyIdentity["scopes"]): KeyIdentity => ({
  id: "handle000001",
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
  const client = new Client({ name: "handle-test", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

const call = async (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: "lit_search", arguments: args });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-handle-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  delete process.env.AGENTIC_PASSWORD;

  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockResolvedValue({
    ok: true,
    script: "handles <- c('repec:aea:aer:1')",
    strategy: "Sweep the monopsony literature.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  });
  executeScript.mockImplementation(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
    for (const p of Object.values(papers)) onEvent({ type: "paper", paper: p });
    onEvent({ type: "section", section });
    onEvent({ type: "bibtex", entries: N_PAPERS, bibtex });
    return { ok: true, papers, persons: {}, sections: [section], bibtex };
  });
  synthesize.mockResolvedValue("## Review");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("lit_search — auto delivery", () => {
  it("hands back a handle (not the artifacts) when the run is too big to inline", async () => {
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await call(client, { brief: "Auto probe: employer concentration and wage markdowns in local markets." });

    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.delivery).toBe("handle");
    expect(sc.mode).toBe("script_only");
    expect(sc.n_papers).toBe(N_PAPERS);
    // The bulk is withheld — that is the whole point.
    expect(sc.papers).toBeUndefined();
    expect(sc.papers_csv).toBeUndefined();
    expect(sc.bibtex).toBeUndefined();
    expect(sc.script).toBeUndefined();
    // But the handle and the route back to the artifacts are not.
    expect(sc.search_id).toEqual(expect.any(String));
    expect(sc.resource_uri).toBe(`agenticsearch://searches/${sc.search_id as string}`);
    expect((sc.fetch as { tool: string }).tool).toBe("fetch_search");
    // Section shape survives as a summary, without the rows.
    expect((sc.sections as { id: string; n_shown: number }[])[0]).toMatchObject({ id: "sem-1", n_shown: N_PAPERS });
  });

  it("the digest still lists every paper, so the caller can write the review without fetching", async () => {
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await call(client, { brief: "Digest probe: monopsony power across concentrated labour markets." });
    const text = (res.content as { text: string }[])[0].text;

    expect(text).toMatch(/Monopsony 0\b/);
    expect(text).toMatch(/Monopsony 59\b/);
    expect(text).toMatch(/fetch_search/);
    // Exactly once: the digest carries the where-to-fetch sentence in its header, so bolting
    // a footer on as well told the caller the same thing twice.
    expect(text.match(/NOT inlined/g)).toHaveLength(1);
    // Abstracts are exactly what the digest must NOT carry.
    expect(text).not.toContain(ABSTRACT);
    expect(text.length).toBeLessThan(60_000);
  });

  it("deliver='inline' overrides the budget and returns everything", async () => {
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await call(client, {
      brief: "Inline probe: wage markdowns under employer concentration in regional markets.",
      deliver: "inline",
    });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.delivery).toBe("inline");
    expect(Object.keys(sc.papers as Record<string, unknown>)).toHaveLength(N_PAPERS);
    expect(sc.bibtex).toContain("manning0");
  });

  it("deliver='handle' forces a handle even for a run that would have fit", async () => {
    executeScript.mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
      const one = { "repec:aea:aer:0": papers["repec:aea:aer:0"] };
      onEvent({ type: "paper", paper: papers["repec:aea:aer:0"] });
      return { ok: true, papers: one, persons: {}, sections: [], bibtex: "" };
    });
    const client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await call(client, {
      brief: "Forced-handle probe: one paper on wage setting under monopsony conditions.",
      deliver: "handle",
    });
    expect((res.structuredContent as Record<string, unknown>).delivery).toBe("handle");
  });
});

describe("fetch_search — the other half of the handle", () => {
  let client: Client;
  let searchId: string;

  beforeAll(async () => {
    client = await makeClient(scopedKey(["mcp", "lit_search"]));
    const res = await call(client, { brief: "Fetch probe: monopsony wage setting across local labour markets." });
    searchId = (res.structuredContent as { search_id: string }).search_id;
  });

  const fetchPart = async (args: Record<string, unknown>) =>
    client.callTool({ name: "fetch_search", arguments: { search_id: searchId, ...args } });

  it("serves the BibTeX the handle withheld", async () => {
    const res = await fetchPart({ part: "bibtex" });
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toContain("manning0");
  });

  it("paginates papers, and the pages walk the whole run", async () => {
    const first = (await fetchPart({ part: "papers", limit: 10 })).structuredContent as {
      papers: Paper[];
      n_total: number;
      next_offset: number | null;
    };
    expect(first.papers).toHaveLength(10);
    expect(first.n_total).toBe(N_PAPERS);
    expect(first.next_offset).toBe(10);
    expect(first.papers[0].abstract).toBe(ABSTRACT); // the abstracts ARE here, on request

    const last = (await fetchPart({ part: "papers", offset: 50, limit: 10 })).structuredContent as {
      next_offset: number | null;
    };
    expect(last.next_offset).toBeNull();
  });

  it("serves the script and a CSV page with its header", async () => {
    expect((await fetchPart({ part: "script" })).structuredContent).toMatchObject({ part: "script" });
    const csv = (await fetchPart({ part: "csv", limit: 2 })).content as { text: string }[];
    expect(csv[0].text.split("\n")[0]).toMatch(/^handle,title,authors/);
    expect(csv[0].text.split("\n")).toHaveLength(3);
  });

  it("errors on an unknown search_id instead of returning an empty result", async () => {
    const res = await client.callTool({
      name: "fetch_search",
      arguments: { search_id: "deadbeefdeadbeef", part: "bibtex" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No stored search/);
  });

  it("says so plainly when a part is legitimately empty (script-only run has no synthesis)", async () => {
    const res = await fetchPart({ part: "synthesis" });
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toMatch(/no 'synthesis' content/);
  });

  it("refuses a key without the 'lit_search' scope", async () => {
    const restOnly = await makeClient(scopedKey(["mcp"]));
    const res = await restOnly.callTool({
      name: "fetch_search",
      arguments: { search_id: searchId, part: "bibtex" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/lit_search/);
  });
});
