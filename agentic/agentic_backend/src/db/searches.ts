import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "fs/promises";
import { join } from "path";
import type { StreamEvent, AgentInput } from "../agent/types.js";

const DB_PATH = join(process.cwd(), "data", "agentic", "searches.duckdb");

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
  close(): Promise<void>;
}

async function rowsToObjects(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
  const names = reader.columnNames();
  const rows = await reader.getRows();
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

export async function openSearchDb(): Promise<SearchDb> {
  await mkdir(join(process.cwd(), "data", "agentic"), { recursive: true });

  const instance = await DuckDBInstance.create(DB_PATH);
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
      clarify_answer TEXT
    )
  `);

  // Migrate pre-existing tables (created before the blocking clarifier landed).
  await conn.run("ALTER TABLE searches ADD COLUMN IF NOT EXISTS clarify_question TEXT");
  await conn.run("ALTER TABLE searches ADD COLUMN IF NOT EXISTS clarify_answer TEXT");

  return {
    async upsertSearch(id, input) {
      const existing = await rowsToObjects(conn, "SELECT id FROM searches WHERE id = ?", [id]);
      if (existing.length > 0) return;
      await conn.run(
        "INSERT INTO searches (id, brief, categories, min_year, db_snapshot_date, events) VALUES (?, ?, ?, ?, ?, ?)",
        [
          id,
          input.brief,
          input.categories ? JSON.stringify(input.categories) : null,
          input.minYear ?? null,
          input.dbSnapshotDate,
          "[]",
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
      };
    },

    async close() {
      conn.disconnectSync();
    },
  };
}
