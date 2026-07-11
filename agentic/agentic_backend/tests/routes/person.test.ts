import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture, openFixture } from "../search/helpers.js";
import { handleToIdeasUrl } from "../../src/search/personProfile.js";

// Person search embeds the query — mock embedQuery with the fixture vector so the two-stage
// rollup runs Ollama-free; vectorLiteral stays real.
vi.mock("../../src/search/embed.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/search/embed.js")>();
  const { loadQueryVec } = await import("../search/helpers.js");
  const { vec } = loadQueryVec();
  return { ...actual, embedQuery: async () => vec };
});

let app: Hono;
let tmp = "";
let profileId = ""; // has a wikidata row
let worksId = ""; // most in-corpus works
let nameNeedle = ""; // a substring guaranteed to match a person

beforeAll(async () => {
  requireFixture();
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);

  const fx = await openFixture();
  profileId = String((await fx.query("SELECT p.short_id FROM persons p JOIN person_wikidata w ON w.short_id = p.short_id LIMIT 1"))[0].short_id);
  worksId = String((await fx.query("SELECT short_id, COUNT(*) n FROM person_works GROUP BY short_id ORDER BY n DESC LIMIT 1"))[0].short_id);
  const nm = String((await fx.query("SELECT name_last FROM persons WHERE name_last IS NOT NULL AND LENGTH(name_last) > 3 LIMIT 1"))[0].name_last);
  nameNeedle = nm.slice(0, 4);
  fx.close();

  tmp = await mkdtemp(join(tmpdir(), "agentic-person-"));
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
  image_url: string | null;
  score: number;
  stats: { n_works_in_corpus: number | null; total_citations: number | null; first_year: number | null; last_year: number | null };
  evidence: { handle: string; score: number }[];
};
type SearchResp = { query: string; scoring_mode: string; quality_weight: number; n_authors: number; results: WireRow[] };

describe("POST /person/search", () => {
  it("returns the econpeople wire shape with n_authors = page size", async () => {
    const res = await post("/person/search", { query: "minimum wage employment", limit: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResp;
    expect(body.scoring_mode).toBe("breadth");
    expect(body.quality_weight).toBe(0.3);
    expect(body.results.length).toBe(body.n_authors);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(5);

    const r = body.results[0];
    expect(typeof r.short_id).toBe("string");
    expect("workplace_institution" in r).toBe(true);
    expect("image_url" in r).toBe(true);
    // stats is the 4-field subset (no best_score / primary_category / nested wikidata).
    expect(Object.keys(r.stats).sort()).toEqual(["first_year", "last_year", "n_works_in_corpus", "total_citations"]);
    expect(r).not.toHaveProperty("best_score");
    expect(r).not.toHaveProperty("wikidata");
    // evidence scores rounded to <=5 decimals.
    for (const e of r.evidence) expect(e.score).toBe(Math.round(e.score * 1e5) / 1e5);
  });

  it("paginates with offset", async () => {
    const p0 = (await (await post("/person/search", { query: "minimum wage", limit: 2, offset: 0 })).json()) as SearchResp;
    const p1 = (await (await post("/person/search", { query: "minimum wage", limit: 2, offset: 2 })).json()) as SearchResp;
    if (p0.results.length === 2 && p1.results.length > 0) {
      expect(p0.results[0].short_id).not.toBe(p1.results[0].short_id);
    }
  });

  it("an unmatched institution filter yields zero authors", async () => {
    const body = (await (await post("/person/search", { query: "minimum wage", institution: "RePEc:edi:doesnotexist" })).json()) as SearchResp;
    expect(body.n_authors).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("accepts best_match and blended scoring modes", async () => {
    for (const mode of ["best_match", "blended"] as const) {
      const res = await post("/person/search", { query: "monopsony", scoring_mode: mode, limit: 3 });
      expect(res.status).toBe(200);
      expect(((await res.json()) as SearchResp).scoring_mode).toBe(mode);
    }
  });

  it("400s a missing query", async () => {
    expect((await post("/person/search", { limit: 3 })).status).toBe(400);
  });

  it("logs a person_search_logs row", async () => {
    await post("/person/search", { query: "logging probe wages", scoring_mode: "breadth", min_year: 2000 });
    const { getAppDataDb } = await import("../../src/db/singleton.js");
    const adb = await getAppDataDb();
    const rows = await adb.query("SELECT * FROM person_search_logs ORDER BY search_id DESC LIMIT 1");
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].has_min_year)).toBe(true);
    expect(String(rows[0].scoring_mode)).toBe("breadth");
  });
});

describe("POST /person/search/save + GET /person/search/:hash", () => {
  it("saves and reloads a person search", async () => {
    const save = await post("/person/search/save", {
      query: "wage effects",
      scoring_mode: "breadth",
      quality_weight: 0.3,
      results: [{ short_id: "pxx1", name_full: "Test" }],
    });
    const { hash } = (await save.json()) as { hash: string };
    expect(hash).toHaveLength(8);

    const load = await app.request(`/person/search/${hash}`);
    const body = (await load.json()) as { hash: string; query: string; scoring_mode: string; results: unknown[] };
    expect(body.hash).toBe(hash);
    expect(body.query).toBe("wage effects");
    expect(body.scoring_mode).toBe("breadth");
    expect(body.results.length).toBe(1);
  });

  it("mirrors a not-found saved person search as {error}", async () => {
    const body = await (await app.request("/person/search/deadbeef")).json();
    expect(body).toEqual({ error: "Person search not found" });
  });
});

describe("GET /person/lookup", () => {
  it("finds people by name substring", async () => {
    const res = await app.request(`/person/lookup?name=${encodeURIComponent(nameNeedle)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { short_id: string; name_full: string; n_works_in_corpus: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].short_id).toBe("string");
  });

  it("errors without a name", async () => {
    expect(await (await app.request("/person/lookup")).json()).toEqual({ error: "name parameter required" });
  });
});

describe("GET /person/:short_id", () => {
  it("returns a profile with a wikidata object when present", async () => {
    const res = await app.request(`/person/${profileId}`);
    expect(res.status).toBe(200);
    const p = (await res.json()) as { short_id: string; stats: { primary_category: unknown }; wikidata: unknown; editorial_roles: unknown[]; category_breakdown: unknown[] };
    expect(p.short_id).toBe(profileId);
    expect(p.wikidata).not.toBeNull();
    expect("primary_category" in p.stats).toBe(true);
    expect(Array.isArray(p.editorial_roles)).toBe(true);
    expect(Array.isArray(p.category_breakdown)).toBe(true);
  });

  it("serialises VARCHAR[] wikidata fields as plain JSON arrays, never wrapper objects", async () => {
    // DuckDBListValue leaks as {"items":[...]} unless rowsToObjects unwraps it — the
    // econpeople frontend does wd.citizenships.join(", ") and would silently break.
    const p = (await (await app.request(`/person/${profileId}`)).json()) as {
      wikidata: Record<string, unknown>;
    };
    const listFields = ["citizenships", "educated_at", "doctoral_advisors", "doctoral_students",
      "fields_of_work", "memberships", "awards"];
    for (const f of listFields) {
      const v = p.wikidata[f];
      expect(v === null || v === undefined || Array.isArray(v), `${f} must be null or a plain array`).toBe(true);
      if (Array.isArray(v)) v.forEach((s) => expect(typeof s).toBe("string"));
    }
  });

  it("mirrors an unknown short_id as {error:'Person not found'}", async () => {
    expect(await (await app.request("/person/pnope999")).json()).toEqual({ error: "Person not found" });
  });
});

describe("GET /person/:short_id/papers", () => {
  it("returns counts and in-corpus rows", async () => {
    const res = await app.request(`/person/${worksId}/papers?limit=5&sort_by=citations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      short_id: string;
      counts: { total: number; in_corpus: number; out_of_corpus: number };
      in_corpus: { handle: string; citations: number }[];
      out_of_corpus: unknown[];
    };
    expect(body.short_id).toBe(worksId);
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.in_corpus.length).toBeGreaterThan(0);
    expect(body.in_corpus.length).toBeLessThanOrEqual(5);
    expect(body.counts.out_of_corpus).toBe(body.counts.total - body.counts.in_corpus);
    expect(Array.isArray(body.out_of_corpus)).toBe(true);
  });
});

describe("person telemetry", () => {
  it("GET /person/stats/searches returns the person aggregate shape", async () => {
    const res = await app.request("/person/stats/searches?days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; scoring_modes: unknown[]; filter_usage: Record<string, number> };
    expect(body.days).toBe(30);
    expect(Array.isArray(body.scoring_modes)).toBe(true);
    expect(body.filter_usage).toHaveProperty("institution_filters");
  });

  it("GET /person/dailylogs validates the day", async () => {
    expect((await app.request("/person/dailylogs")).status).toBe(400);
    expect((await app.request("/person/dailylogs?day=2020-01-01")).status).toBe(200);
  });
});

describe("handleToIdeasUrl (unit)", () => {
  it("maps work_type to the IDEAS path prefix", () => {
    expect(handleToIdeasUrl("repec:aea:aecrev:v:1", "article")).toBe("https://ideas.repec.org/a/aea/aecrev/v/1.html");
    expect(handleToIdeasUrl("repec:nbr:nberwo:23584", "paper")).toBe("https://ideas.repec.org/p/nbr/nberwo/23584.html");
    expect(handleToIdeasUrl("repec:zzz:series:1", "editor-series")).toBe("https://ideas.repec.org/s/zzz/series/1.html");
    expect(handleToIdeasUrl("repec:x:y:z", null)).toBe("https://ideas.repec.org/p/x/y/z.html");
  });
});
