import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture, loadQueryVec } from "../search/helpers.js";

// Mock embedQuery only — vectorLiteral stays real (it builds the SQL vector literal). The
// fixture ships a stored query vector whose own paper must rank first, so /search is
// deterministic without Ollama.
vi.mock("../../src/search/embed.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/search/embed.js")>();
  const { loadQueryVec } = await import("../search/helpers.js");
  const { vec } = loadQueryVec();
  return { ...actual, embedQuery: async () => vec };
});

let app: Hono;
let tmp = "";
let queryHandle = "";

beforeAll(async () => {
  requireFixture();
  queryHandle = loadQueryVec().handle;
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);

  tmp = await mkdtemp(join(tmpdir(), "agentic-search-route-"));
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
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type Row = { Handle: string; similarity: number; similarity_score: number };
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

describe("POST /search", () => {
  it("returns a bare array, ranks the query's own paper first, rounds + sorts", async () => {
    const res = await post("/search", { query: "anything", max_k: 10 });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Row[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].Handle).toBe(queryHandle);

    // similarity_score is round(1 - similarity, 5) and the list is sorted desc by it.
    for (const r of rows) expect(r.similarity_score).toBe(round5(1 - r.similarity));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].similarity_score).toBeGreaterThanOrEqual(rows[i].similarity_score);
    }
  });

  it("rejects a missing query with 400", async () => {
    expect((await post("/search", { max_k: 5 })).status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("writes a search_logs row with the query hash and result count", async () => {
    const res = await post("/search", { query: "logging probe", max_k: 4, min_year: 2000 });
    const rows = (await res.json()) as Row[];

    const { getAppDataDb } = await import("../../src/db/singleton.js");
    const { searchHash } = await import("../../src/db/classic.js");
    const adb = await getAppDataDb();
    const expected = searchHash({
      query: "logging probe",
      maxK: 4,
      minYear: 2000,
      journalFilter: null,
      journalName: null,
      titleKeyword: null,
      authorKeyword: null,
    });
    const logged = await adb.query("SELECT * FROM search_logs WHERE query_hash = ?", [expected]);
    expect(logged.length).toBe(1);
    expect(Number(logged[0].result_count)).toBe(rows.length);
    expect(Boolean(logged[0].has_year_filter)).toBe(true);
  });
});

describe("POST /search jel filter", () => {
  it("accepts a jel CSV (with spaces) and applies the filter", async () => {
    // Fixture precondition: the seed paper has no article_jel rows, so a jel
    // filter must drop it from its own-vector search.
    const { openFixture } = await import("../search/helpers.js");
    const db = await openFixture();
    const seedJel = await db.query(
      "SELECT COUNT(*) AS n FROM article_jel WHERE handle = LOWER(?)",
      [queryHandle],
    );
    const [seedRow] = await db.query("SELECT doi FROM articles WHERE Handle = ?", [queryHandle]);
    db.close();
    expect(Number(seedJel[0].n)).toBe(0); // else the fixture slice changed — pick a new anchor

    const unfiltered = await post("/search", { query: "x", max_k: 10 });
    const rows = (await unfiltered.json()) as (Row & { doi: string | null })[];
    expect(rows[0].Handle).toBe(queryHandle);
    // doi rides along on the classic wire format now.
    expect(rows[0].doi).toBe(seedRow.doi);

    const res = await post("/search", { query: "x", max_k: 10, jel: "J3, C21" });
    expect(res.status).toBe(200);
    const filtered = (await res.json()) as Row[];
    expect(filtered.length).toBeGreaterThan(0);
    filtered.forEach((r) => expect(r.Handle).not.toBe(queryHandle));
  });

  it.each(["J381", "J3;C1", "DROP TABLE", "J3,", "J3,,C1", "%"])(
    "rejects malformed jel %j with 400",
    async (jel) => {
      const res = await post("/search", { query: "x", max_k: 5, jel });
      expect(res.status).toBe(400);
    },
  );

  it("POST /search/save with jel returns the specific 400", async () => {
    const res = await post("/search/save", { query: "x", max_k: 5, jel: "J31" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/jel filter is not yet supported for saved searches/);
  });

  it("POST /search/save without jel is unaffected", async () => {
    const res = await post("/search/save", { query: "no jel here", max_k: 3 });
    expect(res.status).toBe(200);
  });
});

describe("POST /search/save + GET /search/:hash", () => {
  it("saves, returns {hash, results}, and reloads the same search", async () => {
    const save = await post("/search/save", { query: "save me", max_k: 6 });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { hash: string; results: Row[] };
    expect(saved.hash).toHaveLength(8);
    expect(saved.results.length).toBeGreaterThan(0);

    const load = await app.request(`/search/${saved.hash}`);
    expect(load.status).toBe(200);
    const body = (await load.json()) as { hash: string; query: string; max_k: number; results: Row[] };
    expect(body.hash).toBe(saved.hash);
    expect(body.query).toBe("save me");
    expect(body.max_k).toBe(6);
    expect(body.results.length).toBe(saved.results.length);
    expect(body.results[0].similarity_score).toBe(round5(1 - body.results[0].similarity));
  });

  it("mirrors a not-found saved search as 200 + {error, status:404}", async () => {
    const res = await app.request("/search/deadbeef");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: "Search not found", status: 404 });
  });
});
