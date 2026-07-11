import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture, openFixture } from "../search/helpers.js";
import type { CorpusDb } from "../../src/db/corpus.js";

// Phase-5 GAP coverage for /handlestats boxing — extends tests/routes/citations.test.ts.
// The existing file checks handle/total_citations/citations_by_year for one handle; here we
// assert the invariant holds for EVERY column, that all four JSON columns JSON.parse cleanly,
// that integer columns survive JSON serialisation (no 500), and that not-found carries no
// `handle` key while still boxing its error.
let app: Hono;
let statsHandle = "";
let jsonCols: string[] = [];

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;

  const fx: CorpusDb = await openFixture();
  statsHandle = String((await fx.query("SELECT handle FROM handle_stats LIMIT 1"))[0].handle);
  jsonCols = (
    await fx.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'handle_stats' AND data_type = 'JSON'",
    )
  ).map((r) => String(r.column_name));
  fx.close();

  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
});

const q = (h: string) => encodeURIComponent(h);

describe("GET /handlestats — full boxing invariants", () => {
  it("boxes EVERY value in a one-element array and never 500s on integer columns", async () => {
    const res = await app.request(`/handlestats?handle=${q(statsHandle)}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown[]>;

    // Every column is a length-1 array (auto_unbox=FALSE parity).
    for (const [key, val] of Object.entries(data)) {
      expect(Array.isArray(val), `${key} should be boxed`).toBe(true);
      expect(val).toHaveLength(1);
    }

    // Integer columns (pub_year, total_citations, ...) serialised as plain numbers, not BigInt.
    expect(typeof data.total_citations[0]).toBe("number");
    expect(Number.isFinite(data.total_citations[0] as number)).toBe(true);
    expect(typeof data.pub_year[0] === "number" || data.pub_year[0] === null).toBe(true);
  });

  it("keeps every JSON column a string that JSON.parse handles cleanly", async () => {
    const res = await app.request(`/handlestats?handle=${q(statsHandle)}`);
    const data = (await res.json()) as Record<string, unknown[]>;
    expect(jsonCols.length).toBeGreaterThan(0);
    for (const col of jsonCols) {
      const boxed = data[col];
      expect(boxed, `${col} present`).toBeDefined();
      // JSON columns stay strings so the frontend runs its own JSON.parse.
      expect(typeof boxed[0], `${col} is string`).toBe("string");
      expect(() => JSON.parse(boxed[0] as string), `${col} parses`).not.toThrow();
    }
  });

  it("not-found returns 200 + boxed error with NO handle key and no 404 status field", async () => {
    const res = await app.request("/handlestats?handle=RePEc:zzz:never");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(data.error)).toBe(true);
    expect((data.error as unknown[]).length).toBe(1);
    expect("handle" in data).toBe(false);
    expect("status" in data).toBe(false);
  });
});
