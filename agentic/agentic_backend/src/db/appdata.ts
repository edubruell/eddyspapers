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

    async close() {
      conn.disconnectSync();
      instance.closeSync();
    },
  };
}
