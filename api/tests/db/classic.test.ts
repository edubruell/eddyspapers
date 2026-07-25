import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openAppDataDb, type AppDataDb } from "../../src/db/appdata.js";
import {
  saveSearch,
  getSavedSearch,
  logSearch,
  getSearchStats,
  searchLogsDay,
  searchHash,
  type SavedSearchParams,
  type SearchLogInput,
} from "../../src/db/classic.js";
import type { SemanticResult } from "../../src/search/types.js";

// Direct-open the appdata store at a throwaway path (DuckDB's exclusive lock means one
// opener at a time; the singleton is bypassed here so the test owns the handle).
let tmp = "";
let db: AppDataDb;

const openTmp = async (): Promise<AppDataDb> => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-classic-"));
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  db = await openAppDataDb();
  return db;
};

afterEach(async () => {
  if (db) await db.close();
  vi.unstubAllEnvs();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

const params: SavedSearchParams = {
  query: "monopsony and minimum wage",
  maxK: 100,
  minYear: 2010,
  journalFilter: "Top 5 Journals",
  journalName: null,
  titleKeyword: null,
  authorKeyword: null,
  jel: null,
};

const paper = (h: string, sim: number): SemanticResult => ({
  Handle: h,
  title: "t",
  year: 2020,
  authors: "a",
  journal: "j",
  category: "c",
  url: null,
  doi: null,
  bib_tex: null,
  abstract: null,
  similarity: sim,
  similarity_score: 1 - sim,
});

const logInput = (overrides: Partial<SearchLogInput> = {}): SearchLogInput => ({
  ip: "10.0.0.1",
  queryHash: "abcd1234",
  resultCount: 2,
  top3Handles: ["RePEc:a:1", "RePEc:b:2", "RePEc:c:3"],
  flags: {
    hasYear: true,
    hasJournalFilter: true,
    hasJournalName: false,
    hasTitleKeyword: false,
    hasAuthorKeyword: false,
  },
  responseTimeMs: 42,
  ...overrides,
});

const today = async (d: AppDataDb): Promise<string> =>
  String((await d.query("SELECT strftime(now(), '%Y-%m-%d') AS d"))[0].d);

describe("saved searches", () => {
  it("saves once, dedups on identical params, and round-trips", async () => {
    await openTmp();
    const results = [paper("RePEc:x:1", 0.1), paper("RePEc:y:2", 0.2)];

    const h1 = await saveSearch(db, params, results);
    const h2 = await saveSearch(db, params, results);
    expect(h1).toBe(h2);
    expect(h1).toBe(searchHash(params));
    expect(h1).toHaveLength(8);

    const rows = await db.query("SELECT COUNT(*) AS n FROM saved_searches");
    expect(Number(rows[0].n)).toBe(1);

    const loaded = await getSavedSearch(db, h1);
    expect(loaded).not.toBeNull();
    expect(loaded?.query).toBe(params.query);
    expect(loaded?.maxK).toBe(100);
    expect(loaded?.minYear).toBe(2010);
    expect(loaded?.journalFilter).toBe("Top 5 Journals");
    expect(loaded?.journalName).toBeNull();
    expect(loaded?.results).toHaveLength(2);
    expect(loaded?.results[0].Handle).toBe("RePEc:x:1");
  });

  it("returns null for an unknown hash", async () => {
    await openTmp();
    expect(await getSavedSearch(db, "deadbeef")).toBeNull();
  });

  it("hashes different params to different values", async () => {
    await openTmp();
    expect(searchHash(params)).not.toBe(searchHash({ ...params, query: "something else" }));
    expect(searchHash(params)).not.toBe(searchHash({ ...params, minYear: null }));
  });
});

describe("search logs", () => {
  it("assigns sequential ids and stores the handle array", async () => {
    await openTmp();
    await logSearch(db, logInput());
    await logSearch(db, logInput({ top3Handles: [] }));

    const day = await today(db);
    const rows = await searchLogsDay(db, day);
    expect(rows.map((r) => r.search_id)).toEqual([1, 2]);
    expect(rows[0].top3_handles).toEqual(["RePEc:a:1", "RePEc:b:2", "RePEc:c:3"]);
    expect(rows[1].top3_handles).toEqual([]);
    expect(rows[0].has_year_filter).toBe(true);
    expect(rows[0].has_journal_name_filter).toBe(false);
  });

  it("caps stored handles at three", async () => {
    await openTmp();
    await logSearch(db, logInput({ top3Handles: ["a", "b", "c", "d", "e"] }));
    const rows = await searchLogsDay(db, await today(db));
    expect(rows[0].top3_handles).toEqual(["a", "b", "c"]);
  });

  it("returns no rows for a day with no logs", async () => {
    await openTmp();
    await logSearch(db, logInput());
    expect(await searchLogsDay(db, "2000-01-01")).toEqual([]);
  });

  it("aggregates stats within the window with filter breakdown", async () => {
    await openTmp();
    await logSearch(db, logInput({ resultCount: 4, responseTimeMs: 100 }));
    await logSearch(
      db,
      logInput({
        resultCount: 6,
        responseTimeMs: 200,
        flags: {
          hasYear: false,
          hasJournalFilter: false,
          hasJournalName: true,
          hasTitleKeyword: true,
          hasAuthorKeyword: false,
        },
      }),
    );

    const stats = await getSearchStats(db, 30);
    expect(stats.total_searches).toBe(2);
    expect(stats.avg_results).toBe(5);
    expect(stats.avg_response_ms).toBe(150);
    expect(stats.filter_usage).toEqual({
      year_filters: 1,
      journal_filters: 1,
      journal_name_filters: 1,
      title_keyword_filters: 1,
      author_keyword_filters: 0,
    });
  });

  it("reports zero totals and null averages on an empty window", async () => {
    await openTmp();
    const stats = await getSearchStats(db, 30);
    expect(stats.total_searches).toBe(0);
    expect(stats.avg_results).toBeNull();
    expect(stats.avg_response_ms).toBeNull();
    expect(stats.filter_usage.year_filters).toBe(0);
  });
});
