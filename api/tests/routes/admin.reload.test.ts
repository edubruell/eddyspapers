import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// POST /admin/reload reopens the corpus after a pipeline snapshot swap. Gate disabled so the
// admin scope passes through (dev bootstrap). A short drain keeps the old pool from lingering.
let app: Hono;

beforeAll(async () => {
  requireFixture();
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  process.env.CORPUS_RELOAD_DRAIN_MS = "50";
  delete process.env.AGENTIC_PASSWORD;
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  delete process.env.CORPUS_RELOAD_DRAIN_MS;
});

describe("POST /admin/reload", () => {
  it("reopens the snapshot and reports its info", async () => {
    // Open the corpus first so there is a prior pool to swap out.
    expect((await app.request("/stats/total")).status).toBe(200);

    const res = await app.request("/admin/reload", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reloaded: boolean; snapshot: { path: string } };
    expect(body.reloaded).toBe(true);
    expect(body.snapshot.path).toBe(FIXTURE_PATH);

    // The new pool serves normally.
    expect((await app.request("/stats/total")).status).toBe(200);
  });

  it("keeps the old pool serving when the reopen fails", async () => {
    // Point the resolver at a missing file: the new open throws, the swap is skipped.
    process.env.DB_SNAPSHOT = "/nonexistent/snapshot.duckdb";
    const res = await app.request("/admin/reload", { method: "POST" });
    expect(res.status).toBe(500);

    // The previously-open pool is untouched — queries still succeed.
    expect((await app.request("/stats/total")).status).toBe(200);

    process.env.DB_SNAPSHOT = FIXTURE_PATH;
  });
});
