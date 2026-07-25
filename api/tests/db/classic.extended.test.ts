import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openAppDataDb, type AppDataDb } from "../../src/db/appdata.js";
import {
  saveSearch,
  getSavedSearch,
  savePersonSearch,
  getSavedPersonSearch,
  logSearch,
  logPersonSearch,
  searchLogsDay,
  personSearchLogsDay,
  getPersonSearchStats,
  searchHash,
  personSaveHash,
  type SavedSearchParams,
  type SavedPersonSearchParams,
  type SearchLogInput,
  type PersonSearchLogInput,
} from "../../src/db/classic.js";
import type { SemanticResult } from "../../src/search/types.js";
import { canonicalHash8, searchHashInput } from "../../src/search/hash.js";

// Phase-5 GAP coverage for src/db/classic.ts — extends tests/db/classic.test.ts. Focuses on
// hash determinism/per-field discrimination, canonical null handling, the dedup-does-not-
// overwrite rule, the day-boundary window in *LogsDay, and the person-side save/stats/log
// paths (which classic.test.ts does not exercise at the db layer at all).
let tmp = "";
let db: AppDataDb;

const openTmp = async (): Promise<AppDataDb> => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-classic-ext-"));
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

const today = async (d: AppDataDb): Promise<string> =>
  String((await d.query("SELECT strftime(now(), '%Y-%m-%d') AS d"))[0].d);

describe("searchHash determinism and per-field discrimination", () => {
  it("is stable across repeated calls with the same params", async () => {
    const a = searchHash(params);
    const b = searchHash(params);
    const c = searchHash({ ...params });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toHaveLength(8);
  });

  it("changes when ANY single field changes", () => {
    const base = searchHash(params);
    expect(searchHash({ ...params, query: "other" })).not.toBe(base);
    expect(searchHash({ ...params, maxK: 50 })).not.toBe(base);
    expect(searchHash({ ...params, minYear: 2011 })).not.toBe(base);
    expect(searchHash({ ...params, journalFilter: "All" })).not.toBe(base);
    expect(searchHash({ ...params, journalName: "AER" })).not.toBe(base);
    expect(searchHash({ ...params, titleKeyword: "wage" })).not.toBe(base);
    expect(searchHash({ ...params, authorKeyword: "card" })).not.toBe(base);
  });

  it("treats an explicit null the same as an absent optional field (canonical null)", () => {
    // journalName is null in `params`; building it explicitly must not perturb the hash.
    const withExplicitNull = searchHash({ ...params, journalName: null });
    expect(withExplicitNull).toBe(searchHash(params));
  });

  it("null and 0 for a numeric field are distinct", () => {
    expect(searchHash({ ...params, minYear: null })).not.toBe(searchHash({ ...params, minYear: 0 }));
  });
});

describe("jel is backward-compatible with pre-JEL sharelinks", () => {
  // GOLDEN: the exact 8-char hash the pre-JEL code produced for `params` (seven fields,
  // no jel term at all). Computed independently as SHA-256 over the canonical JSON array
  // ["monopsony and minimum wage",100,2010,"Top 5 Journals",null,null,null] → first 8 hex.
  // If the conditional jel-append ever changes the array length/JSON for a jel-less search,
  // this value moves and every existing shared search link breaks. It must never change.
  const GOLDEN_PRE_JEL = "017674e6";

  it("a jel-less search hashes to the exact pre-JEL golden value", () => {
    expect(searchHash(params)).toBe(GOLDEN_PRE_JEL);
  });

  it("an absent jel term and an explicit jel: null hash identically (7-element array)", () => {
    // searchHashInput omits the jel pair entirely when jel is null/absent — so the two
    // input arrays are byte-identical, not merely equal-hashing.
    const absent = searchHashInput({
      query: params.query,
      maxK: params.maxK,
      minYear: params.minYear,
      journalFilter: params.journalFilter,
      journalName: params.journalName,
      titleKeyword: params.titleKeyword,
      authorKeyword: params.authorKeyword,
    });
    const explicitNull = searchHashInput({
      query: params.query,
      maxK: params.maxK,
      minYear: params.minYear,
      journalFilter: params.journalFilter,
      journalName: params.journalName,
      titleKeyword: params.titleKeyword,
      authorKeyword: params.authorKeyword,
      jel: null,
    });
    expect(absent).toHaveLength(7);
    expect(explicitNull).toHaveLength(7);
    expect(absent).toEqual(explicitNull);
    expect(canonicalHash8(absent)).toBe(GOLDEN_PRE_JEL);
    expect(canonicalHash8(explicitNull)).toBe(GOLDEN_PRE_JEL);
  });

  it("setting a jel filter changes the hash (8-element array) and appends the jel term last", () => {
    const withJel = searchHashInput({
      query: params.query,
      maxK: params.maxK,
      minYear: params.minYear,
      journalFilter: params.journalFilter,
      journalName: params.journalName,
      titleKeyword: params.titleKeyword,
      authorKeyword: params.authorKeyword,
      jel: "J31",
    });
    expect(withJel).toHaveLength(8);
    expect(withJel[7]).toEqual(["jel", "J31"]);
    expect(searchHash({ ...params, jel: "J31" })).not.toBe(GOLDEN_PRE_JEL);
    // Distinct jel values give distinct hashes; both differ from the jel-less baseline.
    expect(searchHash({ ...params, jel: "J31" })).not.toBe(searchHash({ ...params, jel: "C21" }));
  });
});

describe("saveSearch dedup keeps the FIRST results (no overwrite)", () => {
  it("a second save with different results does not replace the stored row", async () => {
    await openTmp();
    const first = [paper("RePEc:first:1", 0.1)];
    const second = [paper("RePEc:second:2", 0.9), paper("RePEc:second:3", 0.8)];

    const h1 = await saveSearch(db, params, first);
    const h2 = await saveSearch(db, params, second);
    expect(h1).toBe(h2);

    const rows = await db.query("SELECT COUNT(*) AS n FROM saved_searches");
    expect(Number(rows[0].n)).toBe(1);

    // Plumber only inserts when the hash is absent — the original results survive.
    const loaded = await getSavedSearch(db, h1);
    expect(loaded?.results).toHaveLength(1);
    expect(loaded?.results[0].Handle).toBe("RePEc:first:1");
  });

  it("round-trips an empty result list", async () => {
    await openTmp();
    const h = await saveSearch(db, { ...params, query: "empty results" }, []);
    const loaded = await getSavedSearch(db, h);
    expect(loaded?.results).toEqual([]);
  });
});

describe("personSaveHash determinism and dedup (query/mode/weight only)", () => {
  const pp: SavedPersonSearchParams = { query: "labour supply", scoringMode: "breadth", qualityWeight: 0.3 };

  it("is stable and 8 chars", () => {
    expect(personSaveHash(pp)).toBe(personSaveHash({ ...pp }));
    expect(personSaveHash(pp)).toHaveLength(8);
  });

  it("changes on query / scoring_mode / quality_weight", () => {
    const base = personSaveHash(pp);
    expect(personSaveHash({ ...pp, query: "x" })).not.toBe(base);
    expect(personSaveHash({ ...pp, scoringMode: "best_match" })).not.toBe(base);
    expect(personSaveHash({ ...pp, qualityWeight: 0.5 })).not.toBe(base);
  });

  it("saves once, dedups, and keeps the first results", async () => {
    await openTmp();
    const h1 = await savePersonSearch(db, pp, [{ short_id: "a1" }]);
    const h2 = await savePersonSearch(db, pp, [{ short_id: "b2" }, { short_id: "c3" }]);
    expect(h1).toBe(h2);
    expect(h1).toBe(personSaveHash(pp));

    const rows = await db.query("SELECT COUNT(*) AS n FROM saved_person_searches");
    expect(Number(rows[0].n)).toBe(1);

    const loaded = await getSavedPersonSearch(db, h1);
    expect(loaded?.results).toHaveLength(1);
    expect((loaded?.results[0] as { short_id: string }).short_id).toBe("a1");
    expect(loaded?.scoringMode).toBe("breadth");
    expect(loaded?.qualityWeight).toBe(0.3);
  });

  it("returns null for an unknown person-search hash", async () => {
    await openTmp();
    expect(await getSavedPersonSearch(db, "deadbeef")).toBeNull();
  });
});

const classicLog = (overrides: Partial<SearchLogInput> = {}): SearchLogInput => ({
  ip: "10.0.0.1",
  queryHash: "abcd1234",
  resultCount: 2,
  top3Handles: ["RePEc:a:1"],
  flags: {
    hasYear: false,
    hasJournalFilter: false,
    hasJournalName: false,
    hasTitleKeyword: false,
    hasAuthorKeyword: false,
  },
  responseTimeMs: 10,
  ...overrides,
});

describe("searchLogsDay day-boundary window", () => {
  it("includes a row at 00:00:00 and excludes one at 00:00:00 the next day", async () => {
    await openTmp();
    // Insert two rows with hand-set timestamps straddling the day boundary. Sequence ids
    // are irrelevant here; we bypass logSearch to control the timestamp precisely.
    await db.run(
      `INSERT INTO search_logs
         (search_id, timestamp, ip, query_hash, result_count, top3_handles,
          has_year_filter, has_journal_filter, has_journal_name_filter,
          has_title_keyword, has_author_keyword, response_time_ms)
       VALUES
         (101, TIMESTAMP '2024-03-15 00:00:00', '1.1.1.1', 'in__edge', 1, []::VARCHAR[], false,false,false,false,false, 5),
         (102, TIMESTAMP '2024-03-16 00:00:00', '1.1.1.2', 'out_edge', 1, []::VARCHAR[], false,false,false,false,false, 5)`,
    );
    const rows = await searchLogsDay(db, "2024-03-15");
    expect(rows.map((r) => r.query_hash)).toEqual(["in__edge"]);
  });

  it("stores [] for zero handles round-tripped through logSearch", async () => {
    await openTmp();
    await logSearch(db, classicLog({ top3Handles: [] }));
    const rows = await searchLogsDay(db, await today(db));
    expect(rows[0].top3_handles).toEqual([]);
  });

  it("stores exactly three handles when given exactly three", async () => {
    await openTmp();
    await logSearch(db, classicLog({ top3Handles: ["h1", "h2", "h3"] }));
    const rows = await searchLogsDay(db, await today(db));
    expect(rows[0].top3_handles).toEqual(["h1", "h2", "h3"]);
  });
});

const personLog = (overrides: Partial<PersonSearchLogInput> = {}): PersonSearchLogInput => ({
  ip: "10.0.0.9",
  queryHash: "pqh12345",
  resultCount: 3,
  top3ShortIds: ["pa1", "pb2"],
  scoringMode: "breadth",
  flags: {
    hasMinYear: false,
    hasCategory: false,
    hasInstitution: false,
    hasActiveSince: false,
    hasMinCitations: false,
  },
  responseTimeMs: 20,
  ...overrides,
});

describe("person logs + stats (db layer)", () => {
  it("assigns sequential ids, caps short_ids at three, and honours the day window", async () => {
    await openTmp();
    await logPersonSearch(db, personLog({ top3ShortIds: ["a", "b", "c", "d"] }));
    await logPersonSearch(db, personLog({ top3ShortIds: [] }));
    const rows = await personSearchLogsDay(db, await today(db));
    expect(rows.map((r) => r.search_id)).toEqual([1, 2]);
    expect(rows[0].top3_short_ids).toEqual(["a", "b", "c"]);
    expect(rows[1].top3_short_ids).toEqual([]);
  });

  it("aggregates person stats with scoring_modes and per-filter counts", async () => {
    await openTmp();
    await logPersonSearch(db, personLog({ scoringMode: "breadth", resultCount: 2, responseTimeMs: 100, flags: { hasMinYear: true, hasCategory: false, hasInstitution: true, hasActiveSince: false, hasMinCitations: false } }));
    await logPersonSearch(db, personLog({ scoringMode: "blended", resultCount: 4, responseTimeMs: 200, flags: { hasMinYear: false, hasCategory: true, hasInstitution: true, hasActiveSince: true, hasMinCitations: true } }));

    const stats = await getPersonSearchStats(db, 30);
    expect(stats.total_searches).toBe(2);
    expect(stats.avg_results).toBe(3);
    expect(stats.avg_response_ms).toBe(150);
    expect(stats.filter_usage.min_year_filters).toBe(1);
    expect(stats.filter_usage.category_filters).toBe(1);
    expect(stats.filter_usage.institution_filters).toBe(2);
    expect(stats.filter_usage.active_since_filters).toBe(1);
    expect(stats.filter_usage.min_citations_filters).toBe(1);
    const modeMap = Object.fromEntries(stats.scoring_modes.map((m) => [m.scoring_mode, m.n]));
    expect(modeMap.breadth).toBe(1);
    expect(modeMap.blended).toBe(1);
  });

  it("reports zero totals and null averages on an empty window", async () => {
    await openTmp();
    const stats = await getPersonSearchStats(db, 30);
    expect(stats.total_searches).toBe(0);
    expect(stats.avg_results).toBeNull();
    expect(stats.avg_response_ms).toBeNull();
    expect(stats.scoring_modes).toEqual([]);
    expect(stats.filter_usage.institution_filters).toBe(0);
  });
});
