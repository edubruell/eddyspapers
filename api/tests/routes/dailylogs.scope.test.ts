import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// Both daily-log routes return visitor IPs. nginx injects a rest key on every public classic
// and EconPeople /api/ request, so these routes must refuse rest and admit only admin.
let app: Hono;
let tmp = "";
let restKey = "";
let adminKey = "";

beforeAll(async () => {
  requireFixture();
  vi.resetModules();
  tmp = await mkdtemp(join(tmpdir(), "agentic-dailylogs-"));
  vi.stubEnv("DB_SNAPSHOT", FIXTURE_PATH);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  vi.stubEnv("AGENTIC_PASSWORD", "pw");

  const keys = await import("../../src/auth/keys.js");
  const { getAppDataDb } = await import("../../src/db/singleton.js");
  const db = await getAppDataDb();
  const rest = keys.generateKey();
  const admin = keys.generateKey();
  await db.createKey({ keyHash: rest.keyHash, label: "frontend", scopes: ["rest"] });
  await db.createKey({ keyHash: admin.keyHash, label: "operator", scopes: ["admin"] });
  await keys.getKeyRegistry().ensureFresh(true);
  restKey = rest.key;
  adminKey = admin.key;

  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe.each(["/dailylogs", "/person/dailylogs"])("%s scope", (path) => {
  const url = `${path}?day=2020-01-01`;

  it("refuses the rest key that nginx injects", async () => {
    const res = await app.request(url, { headers: { "x-api-key": restKey } });
    expect(res.status).toBe(403);
  });

  it("refuses a request without a key", async () => {
    expect((await app.request(url)).status).toBe(401);
  });

  it("serves an admin key", async () => {
    const res = await app.request(url, { headers: { "x-api-key": adminKey } });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
