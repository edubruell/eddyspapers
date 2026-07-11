import { openSearchDb, type SearchDb } from "./searches.js";
import { openCorpusDb, type CorpusDb } from "./corpus.js";
import { openAppDataDb, type AppDataDb } from "./appdata.js";
import type { SnapshotInfo } from "../sandbox/snapshot.js";
import { clearGuideCache } from "../search/guide.js";

let instance: SearchDb | null = null;

export async function getSearchDb(): Promise<SearchDb> {
  if (!instance) {
    instance = await openSearchDb();
  }
  return instance;
}

let appdata: Promise<AppDataDb> | null = null;

// The Hono-owned read-write appdata store (api_keys today). Held as a single persistent
// handle for the process's lifetime — DuckDB takes an exclusive cross-process file lock,
// so key mutations go through the running server's /admin routes, never a second opener.
export function getAppDataDb(): Promise<AppDataDb> {
  if (!appdata) {
    appdata = openAppDataDb().catch((err: unknown) => {
      appdata = null;
      throw err;
    });
  }
  return appdata;
}

// Test hook: drop the cached handle so the next getAppDataDb() reopens a freshly-pointed
// AGENTIC_APPDATA_PATH. Closes the current handle to release its file lock first.
export async function resetAppDataDb(): Promise<void> {
  if (appdata) {
    const db = await appdata.catch(() => null);
    appdata = null;
    if (db) await db.close();
  }
}

let corpus: Promise<CorpusDb> | null = null;

// Promise-cached (not instance-cached) so concurrent first requests share one
// open instead of racing to create duplicate pools. A failed open clears the
// cache — otherwise one transient failure (snapshot mid-swap) 500s every later
// request until restart.
export function getCorpusDb(): Promise<CorpusDb> {
  if (!corpus) {
    corpus = openCorpusDb().catch((err: unknown) => {
      corpus = null;
      throw err;
    });
  }
  return corpus;
}

// How long the previous corpus pool is left open after a reload so in-flight queries can
// drain before its connections close (PLAN.md §6 decision 4). Overridable for tests.
const RELOAD_DRAIN_MS = Number(process.env.CORPUS_RELOAD_DRAIN_MS ?? 30_000);

// Reopen the corpus after a pipeline snapshot swap (POST /admin/reload). Open the new pool
// FIRST — if that throws (mid-swap / missing file), the current pool keeps serving and the
// error propagates untouched. Only on success do we swap the singleton, clear the guide
// cache, and schedule the old pool's close. The agent search_id cache self-invalidates via
// dbSnapshotDate (agent/cache.ts), so nothing else needs poking here.
export async function reloadCorpusDb(): Promise<SnapshotInfo> {
  const next = await openCorpusDb();
  const prev = corpus;
  corpus = Promise.resolve(next);
  clearGuideCache();
  if (prev) {
    void prev
      .then((db) => {
        const t = setTimeout(() => db.close(), RELOAD_DRAIN_MS);
        // Don't keep the process alive just to close a drained pool.
        if (typeof t === "object" && "unref" in t) t.unref();
      })
      .catch(() => undefined);
  }
  return next.snapshot;
}
