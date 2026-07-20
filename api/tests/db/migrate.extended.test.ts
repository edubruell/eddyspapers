import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { migrateAppData } from "../../scripts/migrate_appdata.js";
import { openAppDataDb } from "../../src/db/appdata.js";

// Phase-5 GAP coverage for scripts/migrate_appdata.ts — extends tests/db/migrate.test.ts.
// Covers: (a) a source MISSING one of the four tables reports 0 while the others still copy,
// and (b) sequence restart lands at 1 when the log tables are empty (max→0 → +1).
let tmp = "";

// Build a source that OMITS person_search_logs and has EMPTY search_logs, but non-empty
// saved_searches / saved_person_searches — so we can assert both gaps at once.
async function buildPartialSource(path: string): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const conn = await inst.connect();

  await conn.run(`CREATE TABLE saved_searches (
    hash VARCHAR PRIMARY KEY, query TEXT, max_k INTEGER, min_year INTEGER,
    journal_filter TEXT, journal_name TEXT, title_keyword TEXT, author_keyword TEXT,
    results TEXT, created_at TIMESTAMP)`);
  await conn.run(`INSERT INTO saved_searches VALUES
    ('aaaa1111','q1',100,2010,NULL,NULL,NULL,NULL,'[]', TIMESTAMP '2026-01-01 10:00:00')`);

  // search_logs exists but is EMPTY -> sequence must restart at 1.
  await conn.run(`CREATE TABLE search_logs (
    search_id INTEGER PRIMARY KEY, timestamp TIMESTAMP, ip VARCHAR, query_hash VARCHAR(8),
    result_count INTEGER, top3_handles VARCHAR[], has_year_filter BOOLEAN, has_journal_filter BOOLEAN,
    has_journal_name_filter BOOLEAN, has_title_keyword BOOLEAN, has_author_keyword BOOLEAN,
    response_time_ms INTEGER)`);

  // person_search_logs deliberately NOT created -> reported as 0, others still copy.

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

describe("migrateAppData with a partial / empty-log source", () => {
  it("reports 0 for the missing table, copies the present ones, and restarts empty sequences at 1", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-migrate-ext-"));
    const source = join(tmp, "articles.duckdb");
    await buildPartialSource(source);
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));

    const result = await migrateAppData({ source });

    expect(result.tables).toEqual({
      saved_searches: 1,
      search_logs: 0,
      person_search_logs: 0, // not present in source -> 0, but the copy did not fail
      saved_person_searches: 1,
    });
    // Both log tables empty -> COALESCE(MAX,0)+1 = 1.
    expect(result.sequences).toEqual({ search_logs_seq: 1, person_search_logs_seq: 1 });
    expect(result.frontendKey).toBe("skipped");

    const db = await openAppDataDb();
    try {
      expect(Number((await db.query("SELECT COUNT(*) n FROM saved_searches"))[0].n)).toBe(1);
      expect(Number((await db.query("SELECT COUNT(*) n FROM saved_person_searches"))[0].n)).toBe(1);
      expect(Number((await db.query("SELECT COUNT(*) n FROM person_search_logs"))[0].n)).toBe(0);
      // The restarted sequences hand out 1 first.
      expect(Number((await db.query("SELECT nextval('search_logs_seq') v"))[0].v)).toBe(1);
      expect(Number((await db.query("SELECT nextval('person_search_logs_seq') v"))[0].v)).toBe(1);
    } finally {
      await db.close();
    }
  });
});
