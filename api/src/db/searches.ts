import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import type { StreamEvent, AgentInput } from "../agent/types.js";

// Resolved lazily (not at module load) so tests can point AGENTIC_DB_PATH at a temp file.
const dbPath = (): string =>
  process.env.AGENTIC_DB_PATH ?? join(process.cwd(), "data", "agentic", "searches.duckdb");

export type SearchStatus = "running" | "awaiting_clarification" | "done" | "error";

export interface StoredSearch {
  id: string;
  brief: string;
  categories: string[] | null;
  minYear: number | null;
  dbSnapshotDate: string | null;
  createdAt: string;
  status: SearchStatus;
  events: StreamEvent[];
  synthesis: string | null;
  clarifyQuestion: string | null;
  clarifyAnswer: string | null;
  refine: boolean;
}

// Aggregate usage telemetry for the admin poller (mirrors the semantic-search
// /stats/searches shape: a `days` window plus totals).
export interface SearchStats {
  days: number;
  total_searches: number;
  by_status: Record<string, number>;
  clarified: number;
  refined: number;
}

// One row per run for the admin daily-log poller. `brief` is included because the
// poller is the operator's own tooling — this endpoint sits behind requireAuth.
export interface DailyLogRow {
  id: string;
  created_at: string;
  status: SearchStatus;
  brief: string;
  refine: boolean;
  clarified: boolean;
  n_events: number;
  has_synthesis: boolean;
}

export interface SearchDb {
  upsertSearch(id: string, input: AgentInput & { dbSnapshotDate: string }): Promise<void>;
  appendEvents(id: string, newEvents: StreamEvent[]): Promise<void>;
  finalizeSearch(id: string, status: "done" | "error", synthesis: string): Promise<void>;
  // Suspend a run awaiting the user's clarifier reply (06_clarifier.md §3, Phase A).
  setAwaitingClarification(id: string, question: string): Promise<void>;
  // Atomically claim a paused search: record the reply and flip status back to running for
  // the resume pass (Phase B). Returns false if the row was not in awaiting_clarification
  // (already resumed / done) — closes the double-reply race so only one resume launches.
  recordClarifyAnswer(id: string, answer: string): Promise<boolean>;
  getSearch(id: string): Promise<StoredSearch | null>;
  getStats(days: number): Promise<SearchStats>;
  getDailyLogs(day: string): Promise<DailyLogRow[]>;
  close(): Promise<void>;
}

async function rowsToObjects(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
  const names = reader.columnNames();
  const rows = await reader.getRows();
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

export async function openSearchDb(): Promise<SearchDb> {
  const path = dbPath();
  await mkdir(dirname(path), { recursive: true });

  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();

  await conn.run(`
    CREATE TABLE IF NOT EXISTS searches (
      id VARCHAR PRIMARY KEY,
      brief TEXT NOT NULL,
      categories TEXT,
      min_year INTEGER,
      db_snapshot_date VARCHAR,
      created_at TIMESTAMP DEFAULT now(),
      status VARCHAR DEFAULT 'running',
      events TEXT,
      synthesis TEXT,
      clarify_question TEXT,
      clarify_answer TEXT,
      refine BOOLEAN DEFAULT false
    )
  `);

  // Migrate pre-existing tables (created before the blocking clarifier / multistage landed).
  // DuckDB 1.5.3's WAL replay crashes on `ReplayAlter` for ANY ADD COLUMN (with or without a
  // DEFAULT — it binds a NULL default internally). The real safeguard is the CHECKPOINT below,
  // which folds these ALTERs into the main file at startup so the WAL never replays a schema
  // change on a cold restart. Keeping the columns DEFAULT-free is still tidy, but is NOT what
  // prevents the crash (an earlier comment here wrongly claimed it was; see the 2026-07-26
  // appdata outage — a no-DEFAULT ADD COLUMN detonated all the same).
  await conn.run("ALTER TABLE searches ADD COLUMN IF NOT EXISTS clarify_question TEXT");
  await conn.run("ALTER TABLE searches ADD COLUMN IF NOT EXISTS clarify_answer TEXT");
  await conn.run("ALTER TABLE searches ADD COLUMN IF NOT EXISTS refine BOOLEAN");

  // Fold the ALTERs into the main file now — see the appdata.ts CHECKPOINT for the full why.
  await conn.run("CHECKPOINT");

  return {
    async upsertSearch(id, input) {
      const existing = await rowsToObjects(conn, "SELECT id FROM searches WHERE id = ?", [id]);
      if (existing.length > 0) return;
      await conn.run(
        "INSERT INTO searches (id, brief, categories, min_year, db_snapshot_date, events, refine) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          input.brief,
          input.categories ? JSON.stringify(input.categories) : null,
          input.minYear ?? null,
          input.dbSnapshotDate,
          "[]",
          input.refine ?? false,
        ] as never,
      );
    },

    async appendEvents(id, newEvents) {
      if (newEvents.length === 0) return;
      const rows = await rowsToObjects(conn, "SELECT events FROM searches WHERE id = ?", [id]);
      if (rows.length === 0) return;
      const existing: StreamEvent[] = JSON.parse((rows[0].events as string) ?? "[]");
      const merged = [...existing, ...newEvents];
      await conn.run("UPDATE searches SET events = ? WHERE id = ?", [JSON.stringify(merged), id] as never);
    },

    async finalizeSearch(id, status, synthesis) {
      await conn.run("UPDATE searches SET status = ?, synthesis = ? WHERE id = ?", [status, synthesis, id] as never);
    },

    async setAwaitingClarification(id, question) {
      await conn.run(
        "UPDATE searches SET status = 'awaiting_clarification', clarify_question = ? WHERE id = ?",
        [question, id] as never,
      );
    },

    async recordClarifyAnswer(id, answer) {
      const claimed = await rowsToObjects(
        conn,
        "UPDATE searches SET status = 'running', clarify_answer = ? WHERE id = ? AND status = 'awaiting_clarification' RETURNING id",
        [answer, id],
      );
      return claimed.length > 0;
    },

    async getSearch(id) {
      const rows = await rowsToObjects(conn, "SELECT * FROM searches WHERE id = ?", [id]);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id as string,
        brief: r.brief as string,
        categories: r.categories ? JSON.parse(r.categories as string) : null,
        minYear: r.min_year as number | null,
        dbSnapshotDate: r.db_snapshot_date as string | null,
        createdAt: String(r.created_at),
        status: r.status as SearchStatus,
        events: r.events ? JSON.parse(r.events as string) : [],
        synthesis: (r.synthesis as string | null) ?? null,
        clarifyQuestion: (r.clarify_question as string | null) ?? null,
        clarifyAnswer: (r.clarify_answer as string | null) ?? null,
        refine: Boolean(r.refine),
      };
    },

    async getStats(days) {
      // COUNT()/SUM() come back as BigInt from the node driver — coerce before JSON.
      const totals = await rowsToObjects(
        conn,
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN clarify_question IS NOT NULL THEN 1 ELSE 0 END) AS clarified,
           SUM(CASE WHEN refine THEN 1 ELSE 0 END) AS refined
         FROM searches
         WHERE created_at >= now() - to_days(CAST(? AS INTEGER))`,
        [days],
      );
      const byStatus = await rowsToObjects(
        conn,
        `SELECT status, COUNT(*) AS n
         FROM searches
         WHERE created_at >= now() - to_days(CAST(? AS INTEGER))
         GROUP BY status`,
        [days],
      );
      return {
        days,
        total_searches: Number(totals[0]?.total ?? 0),
        by_status: Object.fromEntries(byStatus.map((r) => [String(r.status), Number(r.n)])),
        clarified: Number(totals[0]?.clarified ?? 0),
        refined: Number(totals[0]?.refined ?? 0),
      };
    },

    async getDailyLogs(day) {
      const rows = await rowsToObjects(
        conn,
        `SELECT id, created_at, status, brief, refine, clarify_question, events, synthesis
         FROM searches
         WHERE created_at >= CAST(? AS TIMESTAMP)
           AND created_at <  CAST(? AS TIMESTAMP) + INTERVAL 1 DAY
         ORDER BY created_at`,
        [day, day],
      );
      return rows.map((r) => ({
        id: r.id as string,
        created_at: String(r.created_at),
        status: r.status as SearchStatus,
        brief: r.brief as string,
        refine: Boolean(r.refine),
        clarified: r.clarify_question != null,
        n_events: r.events ? (JSON.parse(r.events as string) as unknown[]).length : 0,
        has_synthesis: typeof r.synthesis === "string" && r.synthesis.length > 0,
      }));
    },

    async close() {
      conn.disconnectSync();
    },
  };
}
