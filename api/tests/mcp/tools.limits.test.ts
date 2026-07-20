import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KeyIdentity } from "../../src/auth/keys.js";

// Per-key hourly rate limiting on a *cheap* MCP tool (find_papers), exercised through the
// real tool path (buildMcpServer → withRateLimit → guarded fn). The search layer and the
// corpus DB are mocked so nothing touches Ollama/DuckDB: the point is the guard, not the
// query. PLAN.md §12.4 hot spot: "limiter races at the boundary" + "keys handed out".

const semanticSearch = vi.fn(async () => [] as unknown[]);

vi.mock("../../src/search/papers.js", () => ({
  semanticSearch: (...a: unknown[]) => semanticSearch(...a),
  keywordSearch: vi.fn(),
  verifyReferences: vi.fn(),
}));
vi.mock("../../src/search/persons.js", () => ({ personSearch: vi.fn() }));
vi.mock("../../src/search/guide.js", () => ({ corpusGuide: vi.fn(async () => ({})) }));
vi.mock("../../src/db/singleton.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getCorpusDb: vi.fn(async () => ({})) };
});

async function makeClient(key: KeyIdentity | null): Promise<Client> {
  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer(key);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

const key = (overrides: Record<string, number> | null = null): KeyIdentity => ({
  id: "cheapkey01",
  label: "t",
  scopes: ["rest", "mcp"],
  rateLimitOverrides: overrides,
});

beforeEach(async () => {
  vi.resetModules();
  semanticSearch.mockClear();
  const { getRateLimiter } = await import("../../src/auth/rateLimit.js");
  getRateLimiter().reset();
});

afterEach(() => vi.restoreAllMocks());

describe("find_papers hourly cap at the boundary", () => {
  it("allows the Nth call and blocks the N+1th, consuming no downstream query on block", async () => {
    // Tight override so the boundary is cheap to walk: 3 per hour.
    const client = await makeClient(key({ find_papers: 3 }));

    for (let i = 0; i < 3; i++) {
      const res = await client.callTool({ name: "find_papers", arguments: { query: "minimum wage employment effects across US states" } });
      expect(res.isError).toBeFalsy();
    }
    expect(semanticSearch).toHaveBeenCalledTimes(3);

    // The 4th is blocked by the guard BEFORE the downstream query runs.
    const blocked = await client.callTool({ name: "find_papers", arguments: { query: "another abstract-style prose query about wages" } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toMatch(/limit reached/i);
    expect(semanticSearch).toHaveBeenCalledTimes(3); // no extra downstream call
  });

  it("a null key (gate disabled) is never limited", async () => {
    const client = await makeClient(null);
    for (let i = 0; i < 10; i++) {
      const res = await client.callTool({ name: "find_papers", arguments: { query: "prose query about labour market monopsony effects here" } });
      expect(res.isError).toBeFalsy();
    }
    expect(semanticSearch).toHaveBeenCalledTimes(10);
  });

  it("scopes the cap per key — a second key gets its own fresh quota", async () => {
    const a = await makeClient(key({ find_papers: 1 }));
    expect((await a.callTool({ name: "find_papers", arguments: { query: "first prose query about wage inequality dynamics now" } })).isError).toBeFalsy();
    expect((await a.callTool({ name: "find_papers", arguments: { query: "second prose query that should exceed the tiny cap" } })).isError).toBe(true);

    const b = await makeClient({ ...key({ find_papers: 1 }), id: "otherkey02" });
    expect((await b.callTool({ name: "find_papers", arguments: { query: "different key first prose query about trade flows" } })).isError).toBeFalsy();
  });
});
