import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture, openFixture } from "../search/helpers.js";
import type { CorpusDb } from "../../src/db/corpus.js";

// Citation / version / handlestats routes against the fixture. Handles are discovered from
// the fixture so the assertions don't hard-code corpus contents.
let app: Hono;
let citedHandle = ""; // appears as cit_internal.cited → has internal citedby
let citingHandle = ""; // appears as cit_internal.citing → cites others
let statsHandle = ""; // present in handle_stats
let topCited = ""; // most-cited in cit_all (total >= internal, likely >)
let versionSource: string | null = null;

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;

  const fx: CorpusDb = await openFixture();
  citedHandle = String((await fx.query("SELECT cited FROM cit_internal LIMIT 1"))[0].cited);
  citingHandle = String((await fx.query("SELECT citing FROM cit_internal LIMIT 1"))[0].citing);
  statsHandle = String((await fx.query("SELECT handle FROM handle_stats LIMIT 1"))[0].handle);
  topCited = String(
    (await fx.query("SELECT cited, COUNT(*) AS n FROM cit_all GROUP BY cited ORDER BY n DESC LIMIT 1"))[0]
      .cited,
  );
  const vsrc = await fx.query("SELECT source FROM version_links LIMIT 1");
  versionSource = vsrc.length > 0 ? String(vsrc[0].source) : null;
  fx.close();

  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
});

const get = (path: string) => app.request(path);
const q = (h: string) => encodeURIComponent(h);

describe("GET /citedby & /cites", () => {
  it("citedby returns internal citing papers keyed by lowercase handle", async () => {
    const res = await get(`/citedby?handle=${q(citedHandle)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { handle: string; is_series: boolean | null }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].handle).toBe("string");
    expect("is_series" in rows[0]).toBe(true);
  });

  it("cites returns papers referenced by the handle", async () => {
    const res = await get(`/cites?handle=${q(citingHandle)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("honours the limit param", async () => {
    const rows = (await (await get(`/citedby?handle=${q(citedHandle)}&limit=1`)).json()) as unknown[];
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("400s when handle is missing", async () => {
    expect((await get("/citedby")).status).toBe(400);
  });

  it("returns an empty array for an unknown handle", async () => {
    const rows = (await (await get("/citedby?handle=RePEc:zzz:none")).json()) as unknown[];
    expect(rows).toEqual([]);
  });
});

describe("GET /citationcounts", () => {
  it("returns total >= internal", async () => {
    const res = await get(`/citationcounts?handle=${q(topCited)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total_citations: number; internal_citations: number };
    expect(body.total_citations).toBeGreaterThan(0);
    expect(body.total_citations).toBeGreaterThanOrEqual(body.internal_citations);
  });

  it("returns zeros for an unknown handle", async () => {
    const body = (await (await get("/citationcounts?handle=RePEc:zzz:none")).json()) as {
      total_citations: number;
      internal_citations: number;
    };
    expect(body).toEqual({ total_citations: 0, internal_citations: 0 });
  });
});

describe("GET /versions", () => {
  it("returns an array; rows carry source/target when present", async () => {
    const handle = versionSource ?? citedHandle;
    const res = await get(`/versions?handle=${q(handle)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { source: string; target: string }[];
    expect(Array.isArray(rows)).toBe(true);
    if (versionSource) {
      expect(rows.length).toBeGreaterThan(0);
      expect(typeof rows[0].source).toBe("string");
      expect(typeof rows[0].target).toBe("string");
    }
  });
});

describe("GET /handlestats (boxed, frontend-critical)", () => {
  it("returns every value boxed in a one-element array with string JSON columns", async () => {
    const res = await get(`/handlestats?handle=${q(statsHandle)}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown[]>;
    // The frontend gates on Array.isArray(data.handle).
    expect(Array.isArray(data.handle)).toBe(true);
    expect(typeof data.handle[0]).toBe("string");
    expect(Array.isArray(data.total_citations)).toBe(true);
    // JSON-string columns stay strings so the frontend's own JSON.parse works.
    if (data.citations_by_year) {
      expect(typeof data.citations_by_year[0]).toBe("string");
      expect(() => JSON.parse(data.citations_by_year[0] as string)).not.toThrow();
    }
  });

  it("mirrors not-found as 200 + {error:[...]} (no 404 status, no handle key)", async () => {
    const res = await get("/handlestats?handle=RePEc:zzz:none");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { error?: string[]; handle?: unknown };
    expect(Array.isArray(data.error)).toBe(true);
    expect("handle" in data).toBe(false);
  });

  it("400s when handle is missing", async () => {
    expect((await get("/handlestats")).status).toBe(400);
  });
});
