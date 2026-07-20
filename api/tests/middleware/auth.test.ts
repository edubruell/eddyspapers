import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// env.ts reads process.env once at import, so we must set AGENTIC_PASSWORD BEFORE
// importing the middleware. Each test resets the module registry and re-imports.

async function loadAuth() {
  vi.resetModules();
  const { requireAuth } = await import("../../src/middleware/auth.js");
  return requireAuth;
}

async function appWith() {
  const requireAuth = await loadAuth();
  const app = new Hono();
  app.use("*", requireAuth);
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAuth middleware", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("passes through when the gate is disabled (empty password)", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const app = await appWith();
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a missing key with 401 when the gate is enabled", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong Bearer key with 401", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong x-agentic-key with 401", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { "x-agentic-key": "nope" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct Bearer key with 200", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a case-insensitive 'bearer' scheme", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { authorization: "bearer s3cret" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts the correct x-agentic-key with 200", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { "x-agentic-key": "s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects when the token differs only in length (constant-time path)", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const app = await appWith();
    const res = await app.request("/ping", {
      headers: { authorization: "Bearer s3cretextra" },
    });
    expect(res.status).toBe(401);
  });
});
