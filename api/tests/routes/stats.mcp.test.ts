import { describe, it, expect, vi, afterEach } from "vitest";

// GET /stats/mcp input validation and pass-through. The singleton is mocked so the key gate
// is disabled (no active keys) and getMcpStats sees a stub store.

const loadRoute = async (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => {
  vi.resetModules();
  vi.doMock("../../src/db/singleton.js", () => ({
    getCorpusDb: async () => ({}),
    getSearchDb: async () => ({}),
    getAppDataDb: async () => ({ activeKeys: async () => [], query }),
  }));
  const { statsRoute } = await import("../../src/routes/stats.js");
  return statsRoute;
};

afterEach(() => {
  vi.doUnmock("../../src/db/singleton.js");
  vi.resetModules();
});

describe("GET /stats/mcp", () => {
  it.each(["0", "-3", "1.5", "abc", "", "3651", "1e10"])("rejects days=%s with 400", async (days) => {
    const route = await loadRoute(async () => []);
    const res = await route.request(`/mcp?days=${days}`);
    expect(res.status).toBe(400);
  });

  it("defaults to 30 days and binds days to every placeholder", async () => {
    const calls: unknown[][] = [];
    const route = await loadRoute(async (sql, params) => {
      calls.push(params ?? []);
      expect((sql.match(/\?/g) ?? []).length).toBe((params ?? []).length);
      return [];
    });
    const res = await route.request("/mcp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: 30, signups: { total_live: 0, in_window: 0 }, daily: [], tools: [] });
    expect(calls.flat().every((p) => p === 30)).toBe(true);
  });
});
