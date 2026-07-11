import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// Corpus-count + classic-telemetry stats routes, plus the moved agentic-run telemetry path.
// Gate disabled, so requireKey passes through (dev bootstrap behaviour).
let app: Hono;
let tmp = "";

beforeAll(async () => {
  requireFixture();
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);

  tmp = await mkdtemp(join(tmpdir(), "agentic-stats-"));
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  process.env.AGENTIC_APPDATA_PATH = join(tmp, "appdata.duckdb");
  process.env.AGENTIC_DB_PATH = join(tmp, "searches.duckdb");
  delete process.env.AGENTIC_PASSWORD;
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("corpus stats", () => {
  it("GET /stats/total", async () => {
    const res = await app.request("/stats/total");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total_articles: number }).total_articles).toBeGreaterThan(0);
  });

  it("GET /stats/journals returns {journal, n} rows", async () => {
    const rows = (await (await app.request("/stats/journals")).json()) as { journal: string; n: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].journal).toBe("string");
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("GET /stats/categories is ordered by count desc", async () => {
    const rows = (await (await app.request("/stats/categories")).json()) as { category: string; n: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].n).toBeGreaterThanOrEqual(rows[i].n);
  });

  it("GET /stats/last_updated is unauthenticated and shaped {last_updated}", async () => {
    const res = await app.request("/stats/last_updated");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_updated: string | null };
    expect("last_updated" in body).toBe(true);
    expect(body.last_updated === null || typeof body.last_updated === "string").toBe(true);
  });
});

describe("classic search telemetry", () => {
  it("GET /stats/searches returns the classic aggregate shape", async () => {
    const res = await app.request("/stats/searches?days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; total_searches: number; filter_usage: Record<string, number> };
    expect(body.days).toBe(30);
    expect(body.total_searches).toBe(0);
    expect(body.filter_usage).toHaveProperty("year_filters");
    expect(body.filter_usage).toHaveProperty("author_keyword_filters");
  });

  it("GET /stats/searches rejects days<=0 with 400", async () => {
    expect((await app.request("/stats/searches?days=0")).status).toBe(400);
  });

  it("GET /dailylogs requires a day and returns an array for a valid one", async () => {
    expect((await app.request("/dailylogs")).status).toBe(400);
    const res = await app.request("/dailylogs?day=2020-01-01");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("agentic run telemetry moved under /stats/agentic", () => {
  it("GET /stats/agentic/searches serves the agentic shape (by_status)", async () => {
    const res = await app.request("/stats/agentic/searches?days=7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; by_status: Record<string, number> };
    expect(body.days).toBe(7);
    expect(body).toHaveProperty("by_status");
  });

  it("the old /stats/dailylogs agentic path is gone (now top-level classic /dailylogs)", async () => {
    // /stats/dailylogs no longer routes to the agentic handler; only /stats/agentic/dailylogs does.
    const res = await app.request("/stats/agentic/dailylogs?day=2020-01-01");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
