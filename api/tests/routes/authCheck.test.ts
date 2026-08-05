import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";

// The agentic login screen probes GET /auth/check. It is gated on requireKey('rest') — the
// same scope as the routes the search app actually calls — so one minted key serves as both
// the site login and the MCP token, while the grandfathered AGENTIC_PASSWORD keeps working
// for the existing ZEW preview testers.

let tmp: string;

async function buildAppWith(password: string): Promise<Hono> {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
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

const check = (app: Hono, token?: string) =>
  app.request("/auth/check", token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-authcheck-"));
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("GET /auth/check", () => {
  it("passes through when the gate is disabled (dev)", async () => {
    const app = await buildAppWith("");
    expect((await check(app)).status).toBe(200);
  });

  it("still accepts the legacy AGENTIC_PASSWORD", async () => {
    const app = await buildAppWith("zew-preview-pw");
    const res = await check(app, "zew-preview-pw");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s a missing or wrong token", async () => {
    const app = await buildAppWith("zew-preview-pw");
    expect((await check(app)).status).toBe(401);
    expect((await check(app, "not-the-password")).status).toBe(401);
  });

  it("accepts a minted rest-scoped key, so one key is login + MCP token", async () => {
    const app = await buildAppWith("boot");
    const key = await mint(app, "boot", ["rest", "mcp", "lit_search"]);
    expect((await check(app, key)).status).toBe(200);
  });

  it("403s a key that lacks the rest scope (e.g. an mcp-only key)", async () => {
    const app = await buildAppWith("boot");
    const key = await mint(app, "boot", ["mcp"]);
    const res = await check(app, key);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("rest"),
    });
  });

  it("401s a revoked key", async () => {
    const app = await buildAppWith("boot");
    const key = await mint(app, "boot", ["rest"]);
    expect((await check(app, key)).status).toBe(200);

    const { hashKey } = await import("../../src/auth/keys.js");
    const revoked = await app.request(`/admin/keys/${hashKey(key).slice(0, 12)}`, {
      method: "DELETE",
      headers: { authorization: "Bearer boot" },
    });
    expect(revoked.status).toBe(200);
    expect((await check(app, key)).status).toBe(401);
  });
});
