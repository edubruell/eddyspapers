import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// Phase-5 GAP coverage for the telemetry scope split — extends tests/routes/stats.classic.test.ts
// and tests/routes/person.test.ts. Pins that the three telemetry surfaces serve DIFFERENT
// shapes at their DIFFERENT paths: classic /stats/searches (filter_usage, no by_status),
// agentic /stats/agentic/searches (by_status, no filter_usage), and person /person/stats/searches
// (scoring_modes + institution_filters). Also checks the top-level vs agentic dailylogs paths.
let app: Hono;
let tmp = "";

beforeAll(async () => {
  requireFixture();
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);

  tmp = await mkdtemp(join(tmpdir(), "agentic-telemetry-ext-"));
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

describe("classic vs agentic vs person /stats/searches are distinct shapes", () => {
  it("classic /stats/searches has filter_usage but NOT by_status", async () => {
    const body = (await (await app.request("/stats/searches?days=14")).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("filter_usage");
    expect(body).toHaveProperty("total_searches");
    expect(body).not.toHaveProperty("by_status");
    expect(body).not.toHaveProperty("scoring_modes");
  });

  it("agentic /stats/agentic/searches has by_status but NOT the classic filter_usage", async () => {
    const body = (await (await app.request("/stats/agentic/searches?days=14")).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("by_status");
    expect(body).not.toHaveProperty("filter_usage");
  });

  it("person /person/stats/searches has scoring_modes and institution_filters", async () => {
    const body = (await (await app.request("/person/stats/searches?days=14")).json()) as {
      scoring_modes: unknown[];
      filter_usage: Record<string, number>;
      by_status?: unknown;
    };
    expect(Array.isArray(body.scoring_modes)).toBe(true);
    expect(body.filter_usage).toHaveProperty("institution_filters");
    // The person filter_usage keys are the person set, not the classic set.
    expect(body.filter_usage).not.toHaveProperty("year_filters");
    expect(body).not.toHaveProperty("by_status");
  });
});

describe("dailylogs paths: top-level classic vs agentic-scoped", () => {
  it("top-level /dailylogs and /stats/agentic/dailylogs both return arrays and validate the day", async () => {
    expect((await app.request("/dailylogs")).status).toBe(400);
    expect((await app.request("/stats/agentic/dailylogs")).status).toBe(400);

    const classic = await app.request("/dailylogs?day=2020-01-01");
    const agentic = await app.request("/stats/agentic/dailylogs?day=2020-01-01");
    expect(classic.status).toBe(200);
    expect(agentic.status).toBe(200);
    expect(Array.isArray(await classic.json())).toBe(true);
    expect(Array.isArray(await agentic.json())).toBe(true);
  });

  it("the pre-Phase-5 /stats/dailylogs path no longer routes (classic dailylogs moved to top level)", async () => {
    const res = await app.request("/stats/dailylogs?day=2020-01-01");
    expect(res.status).toBe(404);
  });

  it("person /person/dailylogs validates the day independently", async () => {
    expect((await app.request("/person/dailylogs")).status).toBe(400);
    expect((await app.request("/person/dailylogs?day=2020-01-01")).status).toBe(200);
  });
});

describe("day-count validation across the telemetry surfaces", () => {
  it("rejects days<=0 on classic and person /stats/searches", async () => {
    expect((await app.request("/stats/searches?days=0")).status).toBe(400);
    expect((await app.request("/stats/searches?days=-3")).status).toBe(400);
    expect((await app.request("/person/stats/searches?days=0")).status).toBe(400);
  });
});
