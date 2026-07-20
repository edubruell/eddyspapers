// One-shot migration of the four user-generated tables out of the regen-able corpus file
// (articles.duckdb) into the Hono-owned appdata.duckdb (PLAN.md §A1/§12.3, phase 5 cutover).
//
//   npx tsx scripts/migrate_appdata.ts --source /path/to/articles.duckdb \
//        [--appdata /path/to/appdata.duckdb] [--import-frontend-key] [--force]
//
// Runs OFFLINE (the running server holds appdata's exclusive lock — stop it first, or point
// --appdata at a fresh file). Idempotence guard: refuses to run if any target table already
// has rows, unless force. The id sequences are recreated at max(id)+1 so new inserts don't
// collide with the migrated rows.
import { fileURLToPath } from "url";
import { openAppDataDb } from "../src/db/appdata.js";
import { hashKey } from "../src/auth/keys.js";

const USER_TABLES = ["saved_searches", "search_logs", "person_search_logs", "saved_person_searches"] as const;
const SEQUENCES: Record<string, string> = {
  search_logs: "search_logs_seq",
  person_search_logs: "person_search_logs_seq",
};

// results JSON (src) -> TEXT (appdata): an explicit CAST keeps the copy type-clean.
const COPY_SQL: Record<string, string> = {
  saved_searches:
    "INSERT INTO saved_searches SELECT hash, query, max_k, min_year, journal_filter, journal_name, title_keyword, author_keyword, CAST(results AS VARCHAR), created_at FROM src.saved_searches",
  search_logs: "INSERT INTO search_logs SELECT * FROM src.search_logs",
  person_search_logs: "INSERT INTO person_search_logs SELECT * FROM src.person_search_logs",
  saved_person_searches:
    "INSERT INTO saved_person_searches SELECT hash, query, scoring_mode, quality_weight, CAST(results AS VARCHAR), created_at FROM src.saved_person_searches",
};

const num = (v: unknown): number => Number(v ?? 0);
const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export interface MigrateOptions {
  source: string;
  importFrontendKey?: boolean;
  force?: boolean;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  tables: Record<string, number>;
  sequences: Record<string, number>;
  frontendKey: "added" | "present" | "skipped";
}

export async function migrateAppData(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const db = await openAppDataDb(); // creates the schema (tables + START-1 sequences) if absent
  try {
    if (!opts.force) {
      for (const t of USER_TABLES) {
        const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`);
        if (num(n) > 0) {
          throw new Error(`${t} already has ${num(n)} rows — refusing to migrate (use force to override)`);
        }
      }
    }

    await db.run(`ATTACH ${sqlStr(opts.source)} AS src (READ_ONLY)`);

    const tables: Record<string, number> = {};
    for (const t of USER_TABLES) {
      const exists = await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_catalog = 'src' AND table_name = ?",
        [t],
      );
      if (exists.length === 0) {
        tables[t] = 0;
        log(`- ${t.padEnd(22)} not in source — skipped (0 rows)`);
        continue;
      }
      await db.run(COPY_SQL[t]);
      const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`);
      const [{ s }] = await db.query(`SELECT COUNT(*) AS s FROM src.${t}`);
      if (num(n) !== num(s)) {
        throw new Error(`${t} row-count mismatch after copy (appdata=${num(n)} source=${num(s)})`);
      }
      tables[t] = num(n);
      log(`- ${t.padEnd(22)} ${num(n)} rows`);
    }

    // Recreate the id sequences at max(search_id)+1 so future inserts continue past the
    // migrated rows (the copied rows carry their original search_id).
    const sequences: Record<string, number> = {};
    for (const [table, seq] of Object.entries(SEQUENCES)) {
      const [{ next }] = await db.query(`SELECT COALESCE(MAX(search_id), 0) + 1 AS next FROM ${table}`);
      await db.run(`DROP SEQUENCE IF EXISTS ${seq}`);
      await db.run(`CREATE SEQUENCE ${seq} START ${num(next)}`);
      sequences[seq] = num(next);
      log(`- ${seq.padEnd(22)} restart at ${num(next)}`);
    }

    let frontendKey: MigrateResult["frontendKey"] = "skipped";
    if (opts.importFrontendKey) {
      const plaintext = process.env.EDDYPAPERS_API_KEY;
      if (!plaintext) throw new Error("importFrontendKey needs EDDYPAPERS_API_KEY in the environment");
      const keyHash = hashKey(plaintext);
      const existing = await db.query("SELECT 1 FROM api_keys WHERE key_hash = ?", [keyHash]);
      if (existing.length === 0) {
        await db.createKey({ keyHash, label: "nginx-frontend", scopes: ["rest"] });
        frontendKey = "added";
        log("- api_keys              added nginx-frontend (rest)");
      } else {
        frontendKey = "present";
        log("- api_keys              nginx-frontend already present");
      }
    }

    return { tables, sequences, frontendKey };
  } finally {
    await db.close();
  }
}

// CLI entry — only runs when invoked directly, so tests can import migrateAppData().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argOf = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

  const source = argOf("source");
  if (!source) {
    console.error("error: --source <articles.duckdb> is required");
    process.exit(1);
  }
  const appdataPath = argOf("appdata");
  if (appdataPath) process.env.AGENTIC_APPDATA_PATH = appdataPath;

  migrateAppData({
    source,
    importFrontendKey: hasFlag("import-frontend-key"),
    force: hasFlag("force"),
    log: (m) => console.log(m),
  })
    .then(() => console.log("migration complete"))
    .catch((e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
