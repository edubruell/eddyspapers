import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { openAppDataDb, type AppDataDb } from "../../src/db/appdata.js";

// Regression for the 2026-07-26 outage: an ADD COLUMN migration left uncheckpointed in the
// WAL detonates on the next cold restart because DuckDB 1.5.3's ReplayAlter crashes. The fix
// is the CHECKPOINT after the DDL block in openAppDataDb — it must leave the WAL free of the
// just-applied ALTER, so a later cold open never replays a schema change.

let tmp = "";
let db: AppDataDb | undefined;

afterEach(async () => {
  if (db) await db.close();
  db = undefined;
  vi.unstubAllEnvs();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

// Seed a pre-jel appdata file (saved_searches without the jel column), the exact shape that
// makes openAppDataDb's `ALTER TABLE ... ADD COLUMN jel` do real work rather than no-op.
async function seedPreJelFile(path: string): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE saved_searches (
      hash VARCHAR PRIMARY KEY,
      query TEXT NOT NULL,
      results TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.run("INSERT INTO saved_searches (hash, query, results) VALUES ('h1', 'q', '[]')");
  await conn.run("CHECKPOINT");
  conn.disconnectSync();
  inst.closeSync();
}

const walSize = async (dbFile: string): Promise<number> => {
  try {
    return (await stat(`${dbFile}.wal`)).size;
  } catch {
    return 0; // absent WAL == fully checkpointed
  }
};

describe("appdata WAL is checkpointed after schema migration", () => {
  it("folds the jel ADD COLUMN into the main file (empty WAL, no replay landmine)", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-appdata-wal-"));
    const path = join(tmp, "appdata.duckdb");
    await seedPreJelFile(path);

    vi.stubEnv("AGENTIC_APPDATA_PATH", path);
    db = await openAppDataDb(); // runs the jel ALTER + the CHECKPOINT under test

    // The column is present...
    const rows = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'saved_searches' AND column_name = 'jel'",
    );
    expect(rows).toHaveLength(1);

    // ...and the ALTER did not linger in the WAL to be replayed on a cold restart.
    expect(await walSize(path)).toBe(0);
  });

  it("survives a simulated restart (reopen) without a replay crash", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-appdata-wal-"));
    const path = join(tmp, "appdata.duckdb");
    await seedPreJelFile(path);
    vi.stubEnv("AGENTIC_APPDATA_PATH", path);

    const first = await openAppDataDb();
    await first.close();

    // Cold reopen — would throw the ReplayAlter INTERNAL error if the ALTER were still in the WAL.
    db = await openAppDataDb();
    const rows = await db.query("SELECT count(*) AS n FROM saved_searches");
    expect(Number((rows[0] as { n: bigint | number }).n)).toBe(1);
  });
});
