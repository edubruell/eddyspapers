import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";
import type { Paper, Section } from "../../src/agent/types.js";

// A lit_search that outlasts the bounded wait comes back as status='running' with its
// search_id; fetch_search collects it, an identical re-call joins it, and a different brief
// from the same key is refused with a pointer to the running one. Stages are mocked.

const clarify = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({ clarify: (...a: unknown[]) => clarify(...a) }));
vi.mock("../../src/agent/stages/writeScript.js", () => ({ writeScript: (...a: unknown[]) => writeScript(...a) }));
vi.mock("../../src/agent/stages/execute.js", () => ({ executeScript: (...a: unknown[]) => executeScript(...a) }));
vi.mock("../../src/agent/stages/synthesize.js", () => ({ synthesize: vi.fn() }));
vi.mock("../../src/agent/stages/assess.js", () => ({ assess: vi.fn(), summarizeResult: () => "" }));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const paper: Paper = {
  handle: "repec:aea:aer:1",
  title: "Rooftop Solar Mandates",
  authors: ["Smith, A."],
  year: 2020,
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: "https://x/1",
  doi: null,
  abstract: "We study solar mandates.",
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

// The script writer blocks until the test opens the gate, so a run stays in flight.
let openGate: () => void = () => undefined;
function armPipeline(): void {
  const gate = new Promise<void>((r) => (openGate = r));
  clarify.mockResolvedValue({ action: "proceed" });
  writeScript.mockImplementation(async () => {
    await gate;
    return { ok: true, script: "handles <- c('repec:aea:aer:1')", strategy: "S", attempts: 1, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 } };
  });
  executeScript.mockImplementation(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: "paper", paper });
    onEvent({ type: "section", section });
    return { ok: true, papers: { [paper.handle]: paper }, persons: {}, sections: [section], bibtex: "@article{smith2020,}" };
  });
}

const key: KeyIdentity = { id: "longrun01", label: "t", scopes: ["mcp", "lit_search"], rateLimitOverrides: null, tools: null };

async function makeClient(as: KeyIdentity = key): Promise<Client> {
  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer(as);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

type Running = { status: string; search_id: string; retry_after_sec: number };
const brief = "economics of rooftop solar photovoltaic mandates for new buildings";

let tmp: string;

beforeEach(async () => {
  vi.resetModules();
  writeScript.mockReset();
  tmp = await mkdtemp(join(tmpdir(), "agentic-longrun-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  vi.stubEnv("MCP_LIT_WAIT_MS", "50");
  delete process.env.AGENTIC_PASSWORD;
  const { getRateLimiter } = await import("../../src/auth/rateLimit.js");
  getRateLimiter().reset();
});

afterEach(async () => {
  openGate();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("lit_search — runs longer than the wait", () => {
  it("hands back status='running', then fetch_search returns the finished run", async () => {
    armPipeline();
    const client = await makeClient();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(first.isError).toBeFalsy();
    const running = first.structuredContent as Running;
    expect(running.status).toBe("running");
    expect(JSON.stringify(first.content)).toMatch(/call lit_search again with exactly the same arguments/);

    const stillRunning = await client.callTool({ name: "fetch_search", arguments: { search_id: running.search_id, part: "overview" } });
    expect((stillRunning.structuredContent as Running).status).toBe("running");

    openGate();
    const done = await client.callTool({ name: "fetch_search", arguments: { search_id: running.search_id, part: "overview" } });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ n_papers: 1 });
  });

  it("joins an identical brief that is still running instead of refusing or re-running it", async () => {
    armPipeline();
    const client = await makeClient();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    const again = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(again.isError).toBeFalsy();
    expect((again.structuredContent as Running).search_id).toBe((first.structuredContent as Running).search_id);
    expect(writeScript).toHaveBeenCalledTimes(1);

    openGate();
    const joined = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(joined.isError).toBeFalsy();
    expect((joined.structuredContent as { papers?: unknown }).papers).toBeDefined();
    expect(writeScript).toHaveBeenCalledTimes(1);
  });

  it("refuses a different brief from the same key and names the running search", async () => {
    armPipeline();
    const client = await makeClient();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    const other = await client.callTool({ name: "lit_search", arguments: { brief: "peer effects in residential solar adoption" } });
    expect(other.isError).toBe(true);
    expect(other._meta).toMatchObject({ refused: "rate_limit" });
    expect(JSON.stringify(other.content)).toContain((first.structuredContent as Running).search_id);
  });

  it("frees the key's slot once the run finishes", async () => {
    armPipeline();
    const client = await makeClient();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    openGate();
    await client.callTool({ name: "fetch_search", arguments: { search_id: (first.structuredContent as Running).search_id, part: "overview" } });

    const next = await client.callTool({ name: "lit_search", arguments: { brief: "peer effects in residential solar adoption" } });
    expect(next.isError).toBeFalsy();
  });

  it("reports a stored run left 'running' with no live process as interrupted", async () => {
    const { getSearchDb } = await import("../../src/db/singleton.js");
    const { recordRunOwner } = await import("../../src/agent/ownership.js");
    const db = await getSearchDb();
    await db.restartSearch("orphan0001", { brief: "orphaned by a restart", dbSnapshotDate: "2026-10-26" });
    await recordRunOwner("orphan0001", key);

    const client = await makeClient();
    const res = await client.callTool({ name: "fetch_search", arguments: { search_id: "orphan0001", part: "overview" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/interrupted/);
  });

  it("runs one pipeline when two keys send the same brief at once", async () => {
    armPipeline();
    const [a, b] = await Promise.all([makeClient(), makeClient({ ...key, id: "longrun02" })]);

    const [ra, rb] = await Promise.all([
      a.callTool({ name: "lit_search", arguments: { brief } }),
      b.callTool({ name: "lit_search", arguments: { brief } }),
    ]);
    expect((ra.structuredContent as Running).search_id).toBe((rb.structuredContent as Running).search_id);
    openGate();
    const done = await b.callTool({ name: "fetch_search", arguments: { search_id: (rb.structuredContent as Running).search_id, part: "overview" } });
    expect(done.isError).toBeFalsy();
    expect(writeScript).toHaveBeenCalledTimes(1);

    const next = await a.callTool({ name: "lit_search", arguments: { brief: "peer effects in residential solar adoption" } });
    expect(next.isError).toBeFalsy();
  });

  it("reports a failed detached run as failed and frees the slot", async () => {
    armPipeline();
    writeScript.mockImplementation(async () => {
      throw new Error("model unavailable");
    });
    const client = await makeClient();

    const first = await client.callTool({ name: "lit_search", arguments: { brief } });
    const id = (first.structuredContent as Running | undefined)?.search_id;
    if (id) {
      const res = await client.callTool({ name: "fetch_search", arguments: { search_id: id, part: "overview" } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).not.toMatch(/interrupted/);
    } else {
      expect(first.isError).toBe(true);
    }
    armPipeline();
    const next = await client.callTool({ name: "lit_search", arguments: { brief: "peer effects in residential solar adoption" } });
    expect(next.isError).toBeFalsy();
  });

  it("leaves a run the web app is driving alone", async () => {
    armPipeline();
    const { bus } = await import("../../src/stream/bus.js");
    const { computeSearchId } = await import("../../src/agent/cache.js");
    const { getSearchDb } = await import("../../src/db/singleton.js");
    const { resolveSnapshot } = await import("../../src/sandbox/snapshot.js");
    const snap = await resolveSnapshot();
    const dbSnapshotDate = new Date(Date.now() - (snap.ageMs ?? 0)).toISOString().slice(0, 10);
    const input = { brief, skipClarify: true, synthesize: false, dbSnapshotDate };
    const id = computeSearchId(input);
    const db = await getSearchDb();
    await db.claimSearch(id, input);
    bus.publish(id, { type: "stage", stage: "write", state: "enter", seq: 0 } as never);

    const client = await makeClient();
    const res = await client.callTool({ name: "lit_search", arguments: { brief } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/running in the web app/);
    expect(writeScript).not.toHaveBeenCalled();
    expect((await db.getSearch(id))?.status).toBe("running");
    bus.cleanup(id);
  });
});
