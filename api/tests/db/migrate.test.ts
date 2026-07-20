import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { migrateAppData } from "../../scripts/migrate_appdata.js";
import { openAppDataDb } from "../../src/db/appdata.js";
import { hashKey } from "../../src/auth/keys.js";

// The migration copies the four user tables out of a source articles.duckdb into a fresh
// appdata.duckdb. We build a tiny source DB in-test (no prod dependency) and assert row
// counts, sequence continuity past the max search_id, the idempotence guard, and the
// optional frontend-key import.
let tmp = "";

// Source tables mirror the appdata DDL/column order so `INSERT ... SELECT *` lines up.
async function buildSource(path: string): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE saved_searches (
    hash VARCHAR PRIMARY KEY, query TEXT, max_k INTEGER, min_year INTEGER,
    journal_filter TEXT, journal_name TEXT, title_keyword TEXT, author_keyword TEXT,
    results TEXT, created_at TIMESTAMP)`);
  await conn.run(`INSERT INTO saved_searches VALUES
    ('aaaa1111','q1',100,2010,NULL,NULL,NULL,NULL,'[]', TIMESTAMP '2026-01-01 10:00:00'),
    ('bbbb2222','q2',50,NULL,'Top 5 Journals',NULL,NULL,NULL,'[]', TIMESTAMP '2026-01-02 10:00:00')`);

  await conn.run(`CREATE TABLE search_logs (
    search_id INTEGER PRIMARY KEY, timestamp TIMESTAMP, ip VARCHAR, query_hash VARCHAR(8),
    result_count INTEGER, top3_handles VARCHAR[], has_year_filter BOOLEAN, has_journal_filter BOOLEAN,
    has_journal_name_filter BOOLEAN, has_title_keyword BOOLEAN, has_author_keyword BOOLEAN,
    response_time_ms INTEGER)`);
  await conn.run(`INSERT INTO search_logs VALUES
    (1, TIMESTAMP '2026-01-01 10:00:00','1.1.1.1','h1',5,['a','b'],true,false,false,false,false,42),
    (2, TIMESTAMP '2026-01-01 11:00:00','1.1.1.2','h2',3,[],false,false,false,false,false,17),
    (5, TIMESTAMP '2026-01-02 12:00:00','1.1.1.3','h3',9,['c'],true,true,false,false,false,88)`);

  await conn.run(`CREATE TABLE person_search_logs (
    search_id INTEGER PRIMARY KEY, timestamp TIMESTAMP, ip VARCHAR, query_hash VARCHAR(8),
    result_count INTEGER, top3_short_ids VARCHAR[], scoring_mode VARCHAR, has_min_year BOOLEAN,
    has_category BOOLEAN, has_institution BOOLEAN, has_active_since BOOLEAN, has_min_citations BOOLEAN,
    response_time_ms INTEGER)`);
  await conn.run(`INSERT INTO person_search_logs VALUES
    (7, TIMESTAMP '2026-01-03 09:00:00','2.2.2.2','p1',4,['pa1'],'breadth',true,false,false,false,false,55)`);

  await conn.run(`CREATE TABLE saved_person_searches (
    hash VARCHAR PRIMARY KEY, query TEXT, scoring_mode VARCHAR, quality_weight DOUBLE,
    results TEXT, created_at TIMESTAMP)`);
  await conn.run(`INSERT INTO saved_person_searches VALUES
    ('cccc3333','pq','breadth',0.3,'[]', TIMESTAMP '2026-01-03 09:00:00')`);

  conn.disconnectSync();
  inst.closeSync();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("migrateAppData", () => {
  it("copies the four tables, restarts sequences past max(id), imports the frontend key", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-migrate-"));
    const source = join(tmp, "articles.duckdb");
    await buildSource(source);
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    vi.stubEnv("EDDYPAPERS_API_KEY", "esk_frontend_plaintext");

    const result = await migrateAppData({ source, importFrontendKey: true });
    expect(result.tables).toEqual({
      saved_searches: 2,
      search_logs: 3,
      person_search_logs: 1,
      saved_person_searches: 1,
    });
    // Sequences restart at max(search_id)+1 (5 -> 6, 7 -> 8).
    expect(result.sequences).toEqual({ search_logs_seq: 6, person_search_logs_seq: 8 });
    expect(result.frontendKey).toBe("added");

    // Reopen and confirm the copied rows + that the next sequence value continues past the max.
    const db = await openAppDataDb();
    try {
      expect(Number((await db.query("SELECT COUNT(*) n FROM saved_searches"))[0].n)).toBe(2);
      expect(Number((await db.query("SELECT nextval('search_logs_seq') v"))[0].v)).toBe(6);
      expect(Number((await db.query("SELECT nextval('person_search_logs_seq') v"))[0].v)).toBe(8);
      const key = await db.query("SELECT label, scopes FROM api_keys WHERE key_hash = ?", [
        hashKey("esk_frontend_plaintext"),
      ]);
      expect(key.length).toBe(1);
      expect(String(key[0].label)).toBe("nginx-frontend");
    } finally {
      await db.close();
    }
  });

  it("refuses to run when a target table already has rows (idempotence guard)", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-migrate-"));
    const source = join(tmp, "articles.duckdb");
    await buildSource(source);
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));

    await migrateAppData({ source });
    await expect(migrateAppData({ source })).rejects.toThrow(/already has .* rows/);
  });
});
