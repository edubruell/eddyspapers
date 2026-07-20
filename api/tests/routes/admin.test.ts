import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";

let tmp: string;

async function buildAppWith(password: string): Promise<Hono> {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  const { buildApp } = await import("../../src/app.js");
  return buildApp();
}

const admin = (pw: string) => ({ authorization: `Bearer ${pw}`, "content-type": "application/json" });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-admin-"));
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("/admin/keys", () => {
  it("mints a key (returned once), then authenticates a route with it", async () => {
    const app = await buildAppWith("boot");
    const created = await app.request("/admin/keys", {
      method: "POST",
      headers: admin("boot"),
      body: JSON.stringify({ label: "Alice", scopes: ["rest"] }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key: string; id: string; scopes: string[] };
    expect(body.key.startsWith("esk_")).toBe(true);
    expect(body.scopes).toEqual(["rest"]);

    // The minted key now satisfies requireKey('rest') — a bad body proves it passed auth.
    const used = await app.request("/papers/keyword", {
      method: "POST",
      headers: { authorization: `Bearer ${body.key}` },
      body: "{}",
    });
    expect(used.status).toBe(400);
  });

  it("defaults scopes to rest+mcp when omitted", async () => {
    const app = await buildAppWith("boot");
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: admin("boot"),
      body: JSON.stringify({ label: "Default" }),
    });
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(["rest", "mcp"]);
  });

  it("revokes a key by id prefix and immediately rejects it", async () => {
    const app = await buildAppWith("boot");
    const body = (await (
      await app.request("/admin/keys", {
        method: "POST",
        headers: admin("boot"),
        body: JSON.stringify({ label: "Temp", scopes: ["rest"] }),
      })
    ).json()) as { key: string; id: string };

    const del = await app.request(`/admin/keys/${body.id}`, { method: "DELETE", headers: admin("boot") });
    expect(del.status).toBe(200);
    expect((await del.json()) as { revoked: number }).toEqual({ revoked: 1 });

    const reuse = await app.request("/papers/keyword", {
      method: "POST",
      headers: { authorization: `Bearer ${body.key}` },
      body: "{}",
    });
    expect(reuse.status).toBe(401);
  });

  it("404s revoking a prefix that matches nothing active", async () => {
    const app = await buildAppWith("boot");
    const res = await app.request("/admin/keys/deadbeef", { method: "DELETE", headers: admin("boot") });
    expect(res.status).toBe(404);
  });

  it("400s a revoke prefix shorter than 4 chars", async () => {
    const app = await buildAppWith("boot");
    const res = await app.request("/admin/keys/ab", { method: "DELETE", headers: admin("boot") });
    expect(res.status).toBe(400);
  });

  it("lists keys without leaking the plaintext or hash", async () => {
    const app = await buildAppWith("boot");
    await app.request("/admin/keys", {
      method: "POST",
      headers: admin("boot"),
      body: JSON.stringify({ label: "Listed", scopes: ["rest", "mcp"] }),
    });
    const res = await app.request("/admin/keys", { headers: { authorization: "Bearer boot" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { id: string; label: string }[] };
    const listed = body.keys.find((k) => k.label === "Listed");
    expect(listed?.id).toHaveLength(12);
    expect(JSON.stringify(body)).not.toContain("esk_");
  });

  it("403s a non-admin key on the admin surface", async () => {
    const app = await buildAppWith("boot");
    const restKey = (await (
      await app.request("/admin/keys", {
        method: "POST",
        headers: admin("boot"),
        body: JSON.stringify({ label: "RestOnly", scopes: ["rest"] }),
      })
    ).json()) as { key: string };
    const res = await app.request("/admin/keys", { headers: { authorization: `Bearer ${restKey.key}` } });
    expect(res.status).toBe(403);
  });

  it("401s a same-length-wrong and a wrong-length legacy password through the app", async () => {
    const app = await buildAppWith("boot");
    // Same length as "boot" (4) but wrong bytes.
    expect((await app.request("/admin/keys", { headers: { authorization: "Bearer boat" } })).status).toBe(401);
    // Different length.
    expect((await app.request("/admin/keys", { headers: { authorization: "Bearer bootx" } })).status).toBe(401);
    expect((await app.request("/admin/keys", { headers: { authorization: "Bearer boo" } })).status).toBe(401);
  });

  it("a freshly minted key works immediately (create force-refreshes the registry)", async () => {
    const app = await buildAppWith("boot");
    const body = (await (
      await app.request("/admin/keys", {
        method: "POST",
        headers: admin("boot"),
        body: JSON.stringify({ label: "Instant", scopes: ["rest"] }),
      })
    ).json()) as { key: string };
    // No TTL wait needed — the create path calls ensureFresh(true).
    const used = await app.request("/papers/keyword", {
      method: "POST",
      headers: { authorization: `Bearer ${body.key}` },
      body: "{}",
    });
    expect(used.status).toBe(400); // passed auth, tripped on the empty body
  });

  it("403s an mcp-only key on a rest-scoped route (scope escalation across routes)", async () => {
    const app = await buildAppWith("boot");
    const mcpKey = (await (
      await app.request("/admin/keys", {
        method: "POST",
        headers: admin("boot"),
        body: JSON.stringify({ label: "McpOnly", scopes: ["mcp"] }),
      })
    ).json()) as { key: string };
    const res = await app.request("/papers/keyword", {
      method: "POST",
      headers: { authorization: `Bearer ${mcpKey.key}` },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("bootstraps openly when the gate is disabled (dev, no password/keys)", async () => {
    const app = await buildAppWith("");
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "First", scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
  });
});
