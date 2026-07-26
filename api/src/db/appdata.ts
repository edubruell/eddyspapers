import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";

// appdata.duckdb — the small read-write, Hono-owned store for user/operator data that
// must survive a corpus-snapshot swap (PLAN.md §A1). Phase 4 seeds it with the api_keys
// registry; Phase 5 migrates the remaining user tables (saved_searches, search_logs, …)
// out of the regen-able corpus file into here. Kept separate from searches.duckdb only
// because that file predates this split; both are Hono-exclusive so there is no lock
// contention between them.

const dbPath = (): string =>
  process.env.AGENTIC_APPDATA_PATH ?? join(process.cwd(), "data", "agentic", "appdata.duckdb");

export type Scope = "rest" | "mcp" | "lit_search" | "admin";

export const ALL_SCOPES: readonly Scope[] = ["rest", "mcp", "lit_search", "admin"];

export interface ApiKeyRow {
  keyHash: string;
  label: string;
  scopes: Scope[];
  rateLimitOverrides: Record<string, number> | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AppDataDb {
  // Persist a new key row. The caller hashes the plaintext key first — the plaintext
  // never touches this layer (PLAN.md §D1: store SHA-256, never plaintext).
  createKey(row: {
    keyHash: string;
    label: string;
    scopes: Scope[];
    rateLimitOverrides?: Record<string, number> | null;
  }): Promise<void>;
  revokeKey(hashPrefix: string): Promise<number>;
  listKeys(includeRevoked: boolean): Promise<ApiKeyRow[]>;
  // Only the non-revoked rows, for the auth registry's in-memory cache.
  activeKeys(): Promise<ApiKeyRow[]>;
  // Generic primitives for the ported classic/person user-table logic (src/db/classic.ts).
  // Kept low-level here so the domain SQL lives beside its wire contract, not in this file;
  // both share the one exclusive handle (never open appdata twice — DuckDB locks it).
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

async function rowsToObjects(
  conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
  const names = reader.columnNames();
  const rows = await reader.getRows();
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

const toRow = (r: Record<string, unknown>): ApiKeyRow => ({
  keyHash: r.key_hash as string,
  label: r.label as string,
  scopes: JSON.parse(r.scopes as string) as Scope[],
  rateLimitOverrides: r.rate_limit_overrides
    ? (JSON.parse(r.rate_limit_overrides as string) as Record<string, number>)
    : null,
  createdAt: String(r.created_at),
  revokedAt: r.revoked_at != null ? String(r.revoked_at) : null,
});

export async function openAppDataDb(): Promise<AppDataDb> {
  const path = dbPath();
  await mkdir(dirname(path), { recursive: true });

  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();

  await conn.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash VARCHAR PRIMARY KEY,
      label VARCHAR NOT NULL,
      scopes TEXT NOT NULL,
      rate_limit_overrides TEXT,
      created_at TIMESTAMP DEFAULT now(),
      revoked_at TIMESTAMP
    )
  `);

  // The four user-generated tables ported out of the regen-able corpus file (PLAN.md §A1,
  // Phase 5). Schemas mirror the retired Plumber api.R + persons.R verbatim, except the
  // `results JSON` columns become TEXT here — the payload is a JSON string either way, and
  // TEXT avoids taking a dependency on DuckDB's json extension in this small store. The
  // offline migration (scripts/migrate_appdata.ts) recreates the sequences at max(id)+1;
  // `IF NOT EXISTS START 1` here only seeds a fresh dev/test file and never resets them.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      hash VARCHAR PRIMARY KEY,
      query TEXT NOT NULL,
      max_k INTEGER,
      min_year INTEGER,
      journal_filter TEXT,
      journal_name TEXT,
      title_keyword TEXT,
      author_keyword TEXT,
      jel TEXT,
      results TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Backfill the jel column onto pre-existing appdata files (CREATE ... IF NOT EXISTS
  // never alters an existing table). Idempotent; older rows keep jel NULL.
  await conn.run("ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS jel TEXT");
  await conn.run(`
    CREATE TABLE IF NOT EXISTS search_logs (
      search_id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR,
      query_hash VARCHAR(8),
      result_count INTEGER,
      top3_handles VARCHAR[],
      has_year_filter BOOLEAN,
      has_journal_filter BOOLEAN,
      has_journal_name_filter BOOLEAN,
      has_title_keyword BOOLEAN,
      has_author_keyword BOOLEAN,
      response_time_ms INTEGER
    )
  `);
  await conn.run("CREATE SEQUENCE IF NOT EXISTS search_logs_seq START 1");
  await conn.run(`
    CREATE TABLE IF NOT EXISTS person_search_logs (
      search_id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR,
      query_hash VARCHAR(8),
      result_count INTEGER,
      top3_short_ids VARCHAR[],
      scoring_mode VARCHAR,
      has_min_year BOOLEAN,
      has_category BOOLEAN,
      has_institution BOOLEAN,
      has_active_since BOOLEAN,
      has_min_citations BOOLEAN,
      response_time_ms INTEGER
    )
  `);
  await conn.run("CREATE SEQUENCE IF NOT EXISTS person_search_logs_seq START 1");
  await conn.run(`
    CREATE TABLE IF NOT EXISTS saved_person_searches (
      hash VARCHAR PRIMARY KEY,
      query TEXT NOT NULL,
      scoring_mode VARCHAR,
      quality_weight DOUBLE,
      results TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Fold any schema change just applied above (notably the jel ADD COLUMN) into the main
  // file NOW, so the WAL never carries an ALTER into a cold-start replay. DuckDB 1.5.3's
  // WAL replay crashes on `ReplayAlter` for ADD COLUMN (BindDefaultValues → "GetDefaultDatabase
  // with no default database set"), regardless of whether the column had a DEFAULT. Left
  // uncheckpointed, a migration detonates on the next restart (the 2026-07-26 outage). This
  // does not rely on a clean shutdown — systemd may SIGKILL before close() checkpoints.
  await conn.run("CHECKPOINT");

  return {
    async createKey(row) {
      await conn.run(
        "INSERT INTO api_keys (key_hash, label, scopes, rate_limit_overrides) VALUES (?, ?, ?, ?)",
        [
          row.keyHash,
          row.label,
          JSON.stringify(row.scopes),
          row.rateLimitOverrides ? JSON.stringify(row.rateLimitOverrides) : null,
        ] as never,
      );
    },

    async revokeKey(hashPrefix) {
      const claimed = await rowsToObjects(
        conn,
        "UPDATE api_keys SET revoked_at = now() WHERE key_hash LIKE ? AND revoked_at IS NULL RETURNING key_hash",
        [`${hashPrefix}%`],
      );
      return claimed.length;
    },

    async listKeys(includeRevoked) {
      const where = includeRevoked ? "" : "WHERE revoked_at IS NULL";
      const rows = await rowsToObjects(conn, `SELECT * FROM api_keys ${where} ORDER BY created_at`);
      return rows.map(toRow);
    },

    async activeKeys() {
      const rows = await rowsToObjects(conn, "SELECT * FROM api_keys WHERE revoked_at IS NULL");
      return rows.map(toRow);
    },

    async query(sql, params) {
      return rowsToObjects(conn, sql, params);
    },

    async run(sql, params) {
      if (params) await conn.run(sql, params as never);
      else await conn.run(sql);
    },

    async close() {
      conn.disconnectSync();
      instance.closeSync();
    },
  };
}
