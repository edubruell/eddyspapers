import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";

// POST /chat backs the web app, so `synthesize` defaults TRUE here (unlike MCP lit_search,
// which defaults to script-only). The grant is still the key's: a key without
// 'lit_search_synth' gets the full search and no written review, and the response echoes
// synthesize:false so the UI can say why. Refusing outright would strand a user mid-search.

const runAgent = vi.fn(async () => ({ paused: false }));
vi.mock("../../src/agent/runAgent.js", () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

let tmp: string;

async function buildAppWith(password: string): Promise<Hono> {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  const { buildApp } = await import("../../src/app.js");
  return buildApp();
}

async function mint(app: Hono, adminToken: string, scopes: string[]): Promise<string> {
  const res = await app.request("/admin/keys", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "T", scopes }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

const start = (app: Hono, token: string, brief: string, body: Record<string, unknown> = {}) =>
  app.request("/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ brief, ...body }),
  });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-chatsynth-"));
  runAgent.mockClear();
});

afterEach(async () => {
  const { resetAppDataDb, resetSearchDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  await resetSearchDb?.().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const inputOf = () => (runAgent.mock.calls[0] as unknown[])[1] as { synthesize?: boolean };

describe("POST /chat — synthesis grant", () => {
  it("synthesises for a key carrying lit_search_synth", async () => {
    const app = await buildAppWith("adminpw");
    const key = await mint(app, "adminpw", ["rest", "lit_search_synth"]);
    const res = await start(app, key, "Employer concentration and wage setting across local labour markets.");

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ synthesize: true });
    expect(inputOf().synthesize).toBe(true);
  });

  it("still runs the search for a key without the scope, but writes no review", async () => {
    const app = await buildAppWith("adminpw");
    const key = await mint(app, "adminpw", ["rest"]);
    const res = await start(app, key, "Minimum wages and employment in monopsonistic local markets.");

    expect(res.status).toBe(201);
    // The caller is told, so the UI can explain the missing review rather than looking broken.
    expect(await res.json()).toMatchObject({ synthesize: false });
    expect(inputOf().synthesize).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit synthesize:false even from a granted key", async () => {
    const app = await buildAppWith("adminpw");
    const key = await mint(app, "adminpw", ["rest", "lit_search_synth"]);
    const res = await start(app, key, "Search frictions and matching efficiency in online labour markets.", {
      synthesize: false,
    });

    expect(await res.json()).toMatchObject({ synthesize: false });
    expect(inputOf().synthesize).toBe(false);
  });
});
