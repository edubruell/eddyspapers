import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture, openFixture } from "../search/helpers.js";

// Phase-5 GAP coverage for /person/* — extends tests/routes/person.test.ts. Covers the
// exact case-insensitive institution filter (case-variant matches, substring does NOT),
// offset-past-end, the n_authors == results.length invariant, evidence rounding on a
// case-variant match, papers sort_by=citations ordering, include_out_of_corpus=false, and
// counts.out_of_corpus arithmetic — none of which the base file asserts.
vi.mock("../../src/search/embed.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/search/embed.js")>();
  const { loadQueryVec } = await import("../search/helpers.js");
  const { vec } = loadQueryVec();
  return { ...actual, embedQuery: async () => vec };
});

let app: Hono;
let tmp = "";
let realInstitution = ""; // a genuine workplace_institution value from the fixture
let worksId = ""; // person with the most in-corpus works

beforeAll(async () => {
  requireFixture();
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);

  const fx = await openFixture();
  realInstitution = String(
    (await fx.query("SELECT workplace_institution FROM persons WHERE workplace_institution IS NOT NULL LIMIT 1"))[0]
      .workplace_institution,
  );
  worksId = String(
    (await fx.query("SELECT short_id, COUNT(*) n FROM person_works GROUP BY short_id ORDER BY n DESC LIMIT 1"))[0]
      .short_id,
  );
  fx.close();

  tmp = await mkdtemp(join(tmpdir(), "agentic-person-ext-"));
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  process.env.AGENTIC_APPDATA_PATH = join(tmp, "appdata.duckdb");
  delete process.env.AGENTIC_PASSWORD;
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type WireRow = {
  short_id: string;
  workplace_institution: string | null;
  score: number;
  evidence: { score: number }[];
};
type SearchResp = { n_authors: number; results: WireRow[] };

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

describe("POST /person/search — institution filter is EXACT case-insensitive", () => {
  it("a case-variant of a real institution still matches; n_authors == results.length", async () => {
    // Baseline: how many authors match with the exact stored casing.
    const exact = (await (
      await post("/person/search", { query: "minimum wage employment", institution: realInstitution, limit: 50 })
    ).json()) as SearchResp;

    // Upper-cased variant must match the SAME set (case-insensitive equality).
    const upper = (await (
      await post("/person/search", { query: "minimum wage employment", institution: realInstitution.toUpperCase(), limit: 50 })
    ).json()) as SearchResp;

    expect(upper.n_authors).toBe(exact.n_authors);
    expect(upper.n_authors).toBe(upper.results.length);
    for (const r of upper.results) {
      expect(r.workplace_institution?.toLowerCase()).toBe(realInstitution.toLowerCase());
      // evidence scores are rounded to <=5 decimals.
      for (const e of r.evidence) expect(e.score).toBe(round5(e.score));
    }
  });

  it("a strict substring of a real institution does NOT match (equality, not LIKE)", async () => {
    const needle = realInstitution.slice(0, Math.max(3, realInstitution.length - 2));
    expect(needle).not.toBe(realInstitution);
    const body = (await (
      await post("/person/search", { query: "minimum wage employment", institution: needle, limit: 50 })
    ).json()) as SearchResp;
    expect(body.n_authors).toBe(0);
    expect(body.results).toEqual([]);
  });
});

describe("POST /person/search — pagination edges", () => {
  it("an offset past the end returns an empty page with n_authors == 0", async () => {
    const body = (await (
      await post("/person/search", { query: "minimum wage employment", limit: 5, offset: 100000 })
    ).json()) as SearchResp;
    expect(body.n_authors).toBe(0);
    expect(body.results).toEqual([]);
  });
});

describe("GET /person/:short_id/papers — ordering & counts", () => {
  it("sort_by=citations orders in_corpus by citations descending", async () => {
    const res = await app.request(`/person/${worksId}/papers?limit=50&sort_by=citations&order=desc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { in_corpus: { citations: number }[] };
    for (let i = 1; i < body.in_corpus.length; i++) {
      expect(body.in_corpus[i - 1].citations).toBeGreaterThanOrEqual(body.in_corpus[i].citations);
    }
  });

  it("include_out_of_corpus=false omits the array but preserves the count arithmetic", async () => {
    const res = await app.request(`/person/${worksId}/papers?limit=50&include_out_of_corpus=false`);
    const body = (await res.json()) as {
      counts: { total: number; in_corpus: number; out_of_corpus: number };
      out_of_corpus: unknown[];
    };
    expect(body.out_of_corpus).toEqual([]);
    // counts.out_of_corpus is derived from total - in_corpus regardless of the array flag.
    expect(body.counts.out_of_corpus).toBe(body.counts.total - body.counts.in_corpus);
  });
});

describe("GET /person/:short_id/papers — unknown short_id", () => {
  it("returns zeroed counts and empty arrays for an unknown person", async () => {
    const res = await app.request(`/person/pnope999/papers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      short_id: string;
      counts: { total: number; in_corpus: number; out_of_corpus: number };
      in_corpus: unknown[];
      out_of_corpus: unknown[];
    };
    expect(body.short_id).toBe("pnope999");
    expect(body.counts).toEqual({ total: 0, in_corpus: 0, out_of_corpus: 0 });
    expect(body.in_corpus).toEqual([]);
    expect(body.out_of_corpus).toEqual([]);
  });
});
