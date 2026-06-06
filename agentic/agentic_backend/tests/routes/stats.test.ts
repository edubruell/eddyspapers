import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hermetic tests for the /stats/last_updated proxy. We never hit the real
// semantic API: global.fetch is stubbed and env is mocked so the route's two
// branches (key present / absent) and Plumber's array-wrapping are exercised
// without a live network. The route must always answer 200 and never throw.

const setEnv = (over: Record<string, string>) => {
  vi.doMock("../../src/env.js", () => ({
    env: {
      SEMANTIC_API_BASE: "https://example.test/api",
      EDDYPAPERS_API_KEY: "",
      ...over,
    },
  }));
};

const loadRoute = async () => {
  vi.resetModules();
  const { statsRoute } = await import("../../src/routes/stats.js");
  return statsRoute;
};

describe("GET /stats/last_updated", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null without calling fetch when the API key is unset", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unwraps Plumber's array-wrapped scalar and sends the X-API-Key header", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "secret" });
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ last_updated: ["2026-06-05"] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: "2026-06-05" });

    const [url, init] = (fetchSpy.mock.calls as unknown as any[][])[0];
    expect(url).toBe("https://example.test/api/stats/last_updated");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "secret" });
  });

  it("passes through a plain (non-array) scalar unchanged", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "secret" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ last_updated: "2026-06-05" }), { status: 200 }),
    ));

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(await res.json()).toEqual({ last_updated: "2026-06-05" });
  });

  it("returns null when the upstream payload is an empty array", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "secret" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ last_updated: [] }), { status: 200 }),
    ));

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(await res.json()).toEqual({ last_updated: null });
  });

  it("returns null (200) when the upstream responds non-ok", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "secret" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null });
  });

  it("returns null (200) when fetch rejects", async () => {
    setEnv({ EDDYPAPERS_API_KEY: "secret" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const route = await loadRoute();
    const res = await route.request("/last_updated");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_updated: null });
  });
});
