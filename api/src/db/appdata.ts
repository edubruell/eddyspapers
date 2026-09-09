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

// lit_search grants the tool in its default, script-only mode (search runs server-side, the
// caller gets the script + result rows). lit_search_synth additionally allows asking the
// server to WRITE the review — the one stage that costs real model tokens, so it is a
// separate grant rather than a flag on the first.
export type Scope = "rest" | "mcp" | "lit_search" | "lit_search_synth" | "admin";

export const ALL_SCOPES: readonly Scope[] = ["rest", "mcp", "lit_search", "lit_search_synth", "admin"];

export interface ApiKeyRow {
  keyHash: string;
  label: string;
  // Self-serve signup fields (public_access/01_signup_site.md). NULL on every
  // operator-minted key — only the public mint route fills them in.
  name: string | null;
  email: string | null;
  // The plus-tag-stripped form of `email`, and the column the one-key-per-mailbox rule and
  // the mail cooldown key on (D6). Mail is still SENT to `email` as the user typed it;
  // subaddressing (RFC 5233) would otherwise mint unlimited keys from a single mailbox.
  emailCanonical: string | null;
  institution: string | null;
  // When the mailbox was proven to hold the key. D1 delivers the plaintext key ONLY by mail,
  // so the proof we actually have is "the relay accepted the message" — not that a human
  // read it. NULL means the send never succeeded.
  verifiedAt: string | null;
  scopes: Scope[];
  rateLimitOverrides: Record<string, number> | null;
  // MCP tool allowlist (M9 G). null = every MCP tool (the default, backward-compatible);
  // a name array = only those cheap tools are registered for this key. lit_search stays
  // governed by its own scope, not this list.
  tools: string[] | null;
  createdAt: string;
  revokedAt: string | null;
}

// Canonical form for the one-key-per-mailbox rule: lowercase, trimmed, and with any
// "+tag" subaddress stripped from the local part. Deliberately NOT provider-specific —
// gmail's dot-insensitivity is a known residual we are not chasing, because per-provider
// rules rot and the mail cooldown already blunts the abuse this would catch.
export function canonicalEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const plus = local.indexOf("+");
  return (plus >= 0 ? local.slice(0, plus) : local) + trimmed.slice(at);
}

// Why a mail send is logged separately from the key row: the D6 cooldown must also count
// sends that minted nothing (a repeat request re-sending an existing key), and it is the
// mail-bomb guard — without it the public form is a free "mail this stranger" button.
export type MailKind = "key" | "resend";

export interface AppDataDb {
  // Persist a new key row. The caller hashes the plaintext key first — the plaintext
  // never touches this layer (PLAN.md §D1: store SHA-256, never plaintext).
  createKey(row: {
    keyHash: string;
    label: string;
    scopes: Scope[];
    rateLimitOverrides?: Record<string, number> | null;
    tools?: string[] | null;
    name?: string | null;
    email?: string | null;
    institution?: string | null;
  }): Promise<void>;
  revokeKey(hashPrefix: string): Promise<number>;
  // Re-scope live keys without reissuing them. Keys are only ever identified by their hash,
  // so a scope added later (lit_search_synth was) can be granted to the people already
  // holding a key instead of forcing everyone through a re-mint.
  setKeyScopes(hashPrefix: string, scopes: Scope[]): Promise<ApiKeyRow[]>;
  listKeys(includeRevoked: boolean): Promise<ApiKeyRow[]>;
  // The one-key-per-mailbox lookup behind the public mint route (D6): a repeat signup from
  // the same mailbox re-sends the existing key rather than minting a second. Matches on the
  // canonical form, so "a+tag@x" and "A@x" are one mailbox.
  activeKeyByEmail(email: string): Promise<ApiKeyRow | null>;
  // Record that the mailbox proved out — the relay accepted the key mail.
  markKeyVerified(keyHash: string): Promise<void>;
  // Mail-send ledger for the D6 cooldown + global route budget.
  recordMailSend(email: string, kind: MailKind): Promise<void>;
  // Sends in the last `withinMinutes`; scoped to one mailbox when `email` is given, else the
  // whole route (the circuit breaker).
  countMailSends(withinMinutes: number, email?: string): Promise<number>;
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
  name: (r.name as string | null) ?? null,
  email: (r.email as string | null) ?? null,
  emailCanonical: (r.email_canonical as string | null) ?? null,
  institution: (r.institution as string | null) ?? null,
  verifiedAt: r.verified_at != null ? String(r.verified_at) : null,
  scopes: JSON.parse(r.scopes as string) as Scope[],
  rateLimitOverrides: r.rate_limit_overrides
    ? (JSON.parse(r.rate_limit_overrides as string) as Record<string, number>)
    : null,
  tools: r.tools != null ? (JSON.parse(r.tools as string) as string[]) : null,
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
  // Per-key MCP tool allowlist (M9 G) onto pre-existing api_keys rows. NULL = all tools, so
  // every existing key keeps today's behaviour. Folded into the CHECKPOINT below (WAL landmine).
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tools TEXT");
  // Self-serve signup identity (public_access/01_signup_site.md step 2). NULL on every
  // operator-minted key, so nothing about the existing rows changes. No index on
  // email_canonical: the table holds tens of rows, and an index is one more thing an
  // ALTER has to survive. Folded into the CHECKPOINT below — the WAL landmine applies to
  // these ADD COLUMNs exactly as it did to `tools` and `jel`.
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name VARCHAR");
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS email VARCHAR");
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS email_canonical VARCHAR");
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS institution VARCHAR");
  await conn.run("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP");
  // The D6 mail ledger. A new table rather than columns on api_keys, because a send is not
  // one-to-one with a key: a re-request mints nothing but still costs a message, and the
  // cooldown must count it. Retention is the operator's call — nothing prunes it yet.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS key_mail_log (
      email_canonical VARCHAR NOT NULL,
      kind VARCHAR NOT NULL,
      sent_at TIMESTAMP DEFAULT now()
    )
  `);
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
      const email = row.email?.trim() ? row.email.trim().toLowerCase() : null;
      await conn.run(
        `INSERT INTO api_keys (key_hash, label, scopes, rate_limit_overrides, tools, name, email, email_canonical, institution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.keyHash,
          row.label,
          JSON.stringify(row.scopes),
          row.rateLimitOverrides ? JSON.stringify(row.rateLimitOverrides) : null,
          row.tools != null ? JSON.stringify(row.tools) : null,
          row.name?.trim() || null,
          email,
          email ? canonicalEmail(email) : null,
          row.institution?.trim() || null,
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

    async setKeyScopes(hashPrefix, scopes) {
      const updated = await rowsToObjects(
        conn,
        "UPDATE api_keys SET scopes = ? WHERE key_hash LIKE ? AND revoked_at IS NULL RETURNING *",
        [JSON.stringify(scopes), `${hashPrefix}%`],
      );
      return updated.map(toRow);
    },

    async listKeys(includeRevoked) {
      const where = includeRevoked ? "" : "WHERE revoked_at IS NULL";
      const rows = await rowsToObjects(conn, `SELECT * FROM api_keys ${where} ORDER BY created_at`);
      return rows.map(toRow);
    },

    async activeKeyByEmail(email) {
      const rows = await rowsToObjects(
        conn,
        "SELECT * FROM api_keys WHERE email_canonical = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [canonicalEmail(email)],
      );
      return rows.length > 0 ? toRow(rows[0]) : null;
    },

    async markKeyVerified(keyHash) {
      await conn.run("UPDATE api_keys SET verified_at = now() WHERE key_hash = ?", [keyHash] as never);
    },

    async recordMailSend(email, kind) {
      await conn.run(
        "INSERT INTO key_mail_log (email_canonical, kind) VALUES (?, ?)",
        [canonicalEmail(email), kind] as never,
      );
    },

    async countMailSends(withinMinutes, email) {
      const where = email ? "AND email_canonical = ?" : "";
      const params: unknown[] = [withinMinutes, ...(email ? [canonicalEmail(email)] : [])];
      const rows = await rowsToObjects(
        conn,
        `SELECT COUNT(*) AS n FROM key_mail_log
          WHERE sent_at >= now() - to_minutes(CAST(? AS INTEGER)) ${where}`,
        params,
      );
      return Number(rows[0]?.n ?? 0);
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
