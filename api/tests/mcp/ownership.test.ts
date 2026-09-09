import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";
import type { Paper, Section } from "../../src/agent/types.js";

// Run ownership (security review S6) — the gate in front of self-serve MCP keys. A stored
// run must be readable through fetch_search and the agenticsearch://searches resources ONLY
// by a key that produced it; before this, any mcp-scoped key could read any run by id.
// The by-id share surfaces (GET /searches/:id, the SSE stream) stay ungated by design and
// are deliberately not covered here — see agent/ownership.ts.

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
  handle: "repec:aea:aer:1",
  title: "Monopsony and the Wage Markdown",
  authors: ["Manning, A."],
  year: 2011,
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: "https://x/1",
  abstract: "Employer concentration lowers wages.",
  bibtex: "@article{manning2011,}",
};

const section: Section = {
  id: "sem-1",
  title: "Semantic: monopsony",
  mode: "semantic",
  n_total: 1,
  n_shown: 1,
  rows: [{ handle: paper.handle, rank: 1, similarity: 0.2 }],
};

const key = (id: string, scopes: KeyIdentity["scopes"]): KeyIdentity => ({
  id,
  label: id,
  scopes,
  rateLimitOverrides: null,
  tools: null,
});

const OWNER = key("ownerkey0001", ["mcp", "lit_search"]);
const STRANGER = key("strangerkey1", ["mcp", "lit_search"]);
const ADMIN = key("adminkey0001", ["mcp", "lit_search", "admin"]);

const BRIEF = "Ownership probe: employer concentration and wage markdowns in local labour markets.";

let tmp: string;
let searchId: string;

async function makeClient(k: KeyIdentity | null): Promise<Client> {
  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer(k);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "ownership-test", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

const fetchPart = async (client: Client, id: string, part = "bibtex") =>
  client.callTool({ name: "fetch_search", arguments: { search_id: id, part } });

const overview = async (client: Client, id: string) => {
  const res = (await client.readResource({ uri: `agenticsearch://searches/${id}` })) as {
    contents: { text?: string }[];
  };
  return JSON.parse(res.contents[0].text ?? "{}");
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-ownership-"));
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
    onEvent({ type: "paper", paper });
    onEvent({ type: "section", section });
    onEvent({ type: "bibtex", entries: 1, bibtex: paper.bibtex });
    return { ok: true, papers: { [paper.handle]: paper }, persons: {}, sections: [section], bibtex: paper.bibtex };
  });
  synthesize.mockResolvedValue("## Review");

  const client = await makeClient(OWNER);
  const res = await client.callTool({ name: "lit_search", arguments: { brief: BRIEF } });
  searchId = (res.structuredContent as { search_id: string }).search_id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("fetch_search ownership", () => {
  it("the key that ran the search can read its artifacts back", async () => {
    const res = await fetchPart(await makeClient(OWNER), searchId);
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toContain("manning2011");
  });

  it("another key with the same scopes cannot read the run", async () => {
    const res = await fetchPart(await makeClient(STRANGER), searchId);
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).not.toContain("manning2011");
    // The not-found and not-yours answers must be indistinguishable, or the tool becomes an
    // oracle for which run ids exist.
    const unknown = await fetchPart(await makeClient(STRANGER), "0123456789abcdef");
    expect(text.replace(searchId, "ID")).toBe(
      (unknown.content as { text: string }[])[0].text.replace("0123456789abcdef", "ID"),
    );
  });

  it("an admin key reads any run — the operator's way back into pre-ownership runs", async () => {
    const res = await fetchPart(await makeClient(ADMIN), searchId);
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toContain("manning2011");
  });

  it("a null key (gate disabled / local stdio) is unrestricted", async () => {
    const res = await fetchPart(await makeClient(null), searchId);
    expect(res.isError).toBeFalsy();
  });

  it("re-running the identical brief cache-hits and makes the caller a co-owner", async () => {
    const client = await makeClient(STRANGER);
    const hit = await client.callTool({ name: "lit_search", arguments: { brief: BRIEF } });
    expect((hit.structuredContent as { search_id: string }).search_id).toBe(searchId);

    const res = await fetchPart(client, searchId);
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toContain("manning2011");
  });
});

describe("agenticsearch://searches resource ownership", () => {
  it("the owner reads the overview", async () => {
    // STRANGER co-owns it by now (previous test), so use a fresh third key for the deny case.
    expect((await overview(await makeClient(OWNER), searchId)).brief).toBe(BRIEF);
  });

  it("a non-owner gets the same not-found answer as an unknown id", async () => {
    const outsider = await makeClient(key("outsiderkey1", ["mcp", "lit_search"]));
    expect(await overview(outsider, searchId)).toEqual({ error: "search not found" });
    expect(await overview(outsider, "0123456789abcdef")).toEqual({ error: "search not found" });
  });

  it("a non-owner gets an empty script and bibtex rather than someone else's", async () => {
    const outsider = await makeClient(key("outsiderkey2", ["mcp", "lit_search"]));
    const script = (await outsider.readResource({
      uri: `agenticsearch://searches/${searchId}/script`,
    })) as { contents: { text?: string }[] };
    expect(script.contents[0].text).toBe("");
  });

  it("public corpus resources are unaffected by ownership", async () => {
    const outsider = await makeClient(key("outsiderkey3", ["mcp"]));
    const { resourceTemplates } = await outsider.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain("agenticsearch://searches/{id}");
  });
});
