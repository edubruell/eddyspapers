import { describe, it, expect, vi, afterEach } from "vitest";

// /stats/last_updated is no longer a proxy to the semantic API (PLAN.md §A2): it reads
// db_metadata.last_content_update straight off the corpus snapshot. These hermetic tests
// mock the corpus so both branches (row present / absent / query throws) are covered
// without a fixture, and confirm the route stays unauthenticated and always answers 200.

const loadRoute = async (corpusRows: Record<string, unknown>[] | Error) => {
  vi.resetModules();
  vi.doMock("../../src/db/singleton.js", () => ({
    getCorpusDb: async () => ({
      query: async () => {
        if (corpusRows instanceof Error) throw corpusRows;
        return corpusRows;
      },
      snapshot: {},
      close: () => undefined,
    }),
    getSearchDb: async () => ({}),
    getAppDataDb: async () => ({ activeKeys: async () => [] }),
  }));
  const { statsRoute } = await import("../../src/routes/stats.js");
  return statsRoute;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../src/db/singleton.js");
  vi.resetModules();
});

describe("GET /stats/last_updated (de-proxied)", () => {
  it("returns the recorded date from db_metadata", async () => {
    const route = await loadRoute([{ value: "2026-06-05" }]);
    const res = await route.request("/last_updated");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: "2026-06-05" });
  });

  it("returns null when db_metadata has no matching row", async () => {
    const route = await loadRoute([]);
    const res = await route.request("/last_updated");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null });
  });

  it("returns null (200) when the snapshot lacks db_metadata (query throws)", async () => {
    const route = await loadRoute(new Error("Catalog Error: Table 'db_metadata' does not exist"));
    const res = await route.request("/last_updated");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null });
  });

  it("needs no API key (never wrapped in requireKey)", async () => {
    // No AGENTIC_PASSWORD / keys mocked; the route must still answer 200.
    const route = await loadRoute([{ value: "2026-01-01" }]);
    expect((await route.request("/last_updated")).status).toBe(200);
  });
});
