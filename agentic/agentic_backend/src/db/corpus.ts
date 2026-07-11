import { DuckDBInstance, DuckDBListValue, DuckDBArrayValue } from "@duckdb/node-api";
import { resolveSnapshot, type SnapshotInfo } from "../sandbox/snapshot.js";

// Read-only access to the corpus snapshot (articles + citation + person tables).
// Deliberately separate from db/searches.ts: the corpus file is owned by the R
// pipeline and swapped after each update (PLAN.md §2), while searches.duckdb is
// this service's own read-write store. Never open the corpus writable here.

type Conn = Awaited<ReturnType<DuckDBInstance["connect"]>>;

export interface CorpusDb {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  snapshot: SnapshotInfo;
  close(): void;
}

// DuckDB serialises statements per connection, so a small round-robin pool keeps
// one slow vector scan from queueing every other request (Plumber ran 5; 3 is
// plenty while this service is the only consumer).
const poolSize = (): number => Number(process.env.CORPUS_POOL_SIZE ?? 3);

// LIST/ARRAY columns (e.g. person_wikidata's VARCHAR[] fields) come back as
// DuckDBListValue/DuckDBArrayValue wrappers, which JSON-serialise as objects —
// the wire (and jsonlite parity) needs plain arrays.
const plainValue = (v: unknown): unknown =>
  v instanceof DuckDBListValue || v instanceof DuckDBArrayValue ? v.items.map(plainValue) : v;

const rowsToObjects = async (
  conn: Conn,
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> => {
  // `as never` mirrors db/searches.ts — the node-api param type is narrower than
  // the values DuckDB actually accepts.
  const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
  const names = reader.columnNames();
  const rows = await reader.getRows();
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, plainValue(r[i])])));
};

export async function openCorpusDb(pathOverride?: string): Promise<CorpusDb> {
  const snapshot = await resolveSnapshot(pathOverride);
  if (!snapshot.exists) {
    throw new Error(`corpus snapshot not found (looked at ${snapshot.path})`);
  }

  const instance = await DuckDBInstance.create(snapshot.path, { access_mode: "READ_ONLY" });
  const conns = await Promise.all(
    Array.from({ length: poolSize() }, async () => {
      const conn = await instance.connect();
      // INSTALL is a no-op when the extension is already in ~/.duckdb for this
      // DuckDB version; required once per fresh box (spike finding, scripts/spike_vss.ts).
      await conn.run("INSTALL vss");
      await conn.run("LOAD vss");
      return conn;
    }),
  );

  let cursor = 0;
  const nextConn = (): Conn => {
    cursor = (cursor + 1) % conns.length;
    return conns[cursor];
  };

  return {
    snapshot,
    query: (sql, params) => rowsToObjects(nextConn(), sql, params),
    close: () => conns.forEach((c) => c.disconnectSync()),
  };
}
