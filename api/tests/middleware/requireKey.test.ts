import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";

let tmp: string;

async function appWith(password: string, scope: "rest" | "mcp" | "lit_search" | "admin", seed?: (createKey: (r: { keyHash: string; label: string; scopes: ("rest" | "mcp" | "lit_search" | "admin")[] }) => Promise<void>, keys: typeof import("../../src/auth/keys.js")) => Promise<void>) {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  const keys = await import("../../src/auth/keys.js");
  const { getAppDataDb } = await import("../../src/db/singleton.js");
  if (seed) {
    const db = await getAppDataDb();
    await seed((r) => db.createKey(r), keys);
    await keys.getKeyRegistry().ensureFresh(true);
  }
  const { requireKey, getApiKey } = await import("../../src/middleware/requireKey.js");
  const app = new Hono();
  app.use("*", requireKey(scope));
  app.get("/ping", (c) => c.json({ ok: true, keyId: getApiKey(c)?.id ?? null }));
  return app;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-reqkey-"));
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("requireKey", () => {
  it("passes through, apiKey=null, when the gate is disabled", async () => {
    const app = await appWith("", "rest");
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, keyId: null });
  });

  it("401s a missing token when a password is set", async () => {
    const app = await appWith("pw", "rest");
    expect((await app.request("/ping")).status).toBe(401);
  });

  it("accepts the legacy password and stashes the legacy identity", async () => {
    const app = await appWith("pw", "admin");
    const res = await app.request("/ping", { headers: { authorization: "Bearer pw" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, keyId: "legacy" });
  });

  it("accepts a scoped key via x-api-key and exposes its id", async () => {
    let plaintext = "";
    const app = await appWith("", "mcp", async (createKey, keys) => {
      const g = keys.generateKey();
      plaintext = g.key;
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["mcp"] });
    });
    const res = await app.request("/ping", { headers: { "x-api-key": plaintext } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyId: string };
    expect(body.keyId).toHaveLength(12);
  });

  it("403s a known key that lacks the required scope", async () => {
    let plaintext = "";
    const app = await appWith("", "admin", async (createKey, keys) => {
      const g = keys.generateKey();
      plaintext = g.key;
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["rest", "mcp"] });
    });
    const res = await app.request("/ping", { headers: { authorization: `Bearer ${plaintext}` } });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("admin") });
  });

  it("accepts a scoped key via x-agentic-key (the alternate header name)", async () => {
    let plaintext = "";
    const app = await appWith("", "mcp", async (createKey, keys) => {
      const g = keys.generateKey();
      plaintext = g.key;
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["mcp"] });
    });
    const res = await app.request("/ping", { headers: { "x-agentic-key": plaintext } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keyId: string }).keyId).toHaveLength(12);
  });

  it("accepts a scoped key via a Bearer token (case-insensitive scheme)", async () => {
    let plaintext = "";
    const app = await appWith("", "mcp", async (createKey, keys) => {
      const g = keys.generateKey();
      plaintext = g.key;
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["mcp"] });
    });
    // Lowercase 'bearer' still parses (presentedToken lowercases the scheme).
    const res = await app.request("/ping", { headers: { authorization: `bearer ${plaintext}` } });
    expect(res.status).toBe(200);
  });

  it("prefers the Bearer token over x-api-key when both are present", async () => {
    let good = "";
    const app = await appWith("", "mcp", async (createKey, keys) => {
      const g = keys.generateKey();
      good = g.key;
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["mcp"] });
    });
    // A valid Bearer with a garbage x-api-key still authenticates (Bearer wins).
    const res = await app.request("/ping", {
      headers: { authorization: `Bearer ${good}`, "x-api-key": "esk_garbage" },
    });
    expect(res.status).toBe(200);
  });

  it("401s an unknown key even when other keys exist", async () => {
    const app = await appWith("", "mcp", async (createKey, keys) => {
      const g = keys.generateKey();
      await createKey({ keyHash: g.keyHash, label: "K", scopes: ["mcp"] });
    });
    expect((await app.request("/ping", { headers: { authorization: "Bearer esk_nope" } })).status).toBe(401);
  });
});
