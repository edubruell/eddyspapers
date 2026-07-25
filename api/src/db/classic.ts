import type { AppDataDb } from "./appdata.js";
import type { SemanticResult } from "../search/types.js";
import { canonicalHash8, searchHashInput, personSaveHashInput } from "../search/hash.js";

// The ported classic user-table logic (saved searches + search logs) over the Hono-owned
// appdata store — the Phase 5 replacement for save_search / log_search / get_search_stats
// in the retired Plumber api.R. Person-side equivalents (saved_person_searches, person_search_logs)
// land in M3 alongside the /person routes. One deliberate divergence from Plumber: no
// per-insert CHECKPOINT — this process is the sole writer, so the WAL flush is unnecessary.

const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));

// @duckdb/node-api returns LIST columns as DuckDBListValue ({ items }); guard for plain
// arrays too (mirrors src/search/persons.ts). VARCHAR[] rows come back through here.
const toStrList = (v: unknown): string[] =>
  (Array.isArray(v)
    ? v
    : v != null && typeof v === "object" && "items" in v
      ? (v as { items: unknown[] }).items
      : []
  ).map(String);

// The raw request params a saved search stores and echoes back verbatim (Plumber kept the
// comma-strings, not the split arrays).
export interface SavedSearchParams {
  query: string;
  maxK: number;
  minYear: number | null;
  journalFilter: string | null;
  journalName: string | null;
  titleKeyword: string | null;
  authorKeyword: string | null;
  jel: string | null;
}

export interface SavedSearch extends SavedSearchParams {
  hash: string;
  createdAt: string;
  results: SemanticResult[];
}

export const searchHash = (p: SavedSearchParams): string => canonicalHash8(searchHashInput(p));

// Insert only when the hash is new (Plumber's dedup-on-hash). Returns the hash either way.
export async function saveSearch(
  db: AppDataDb,
  p: SavedSearchParams,
  results: SemanticResult[],
): Promise<string> {
  const hash = searchHash(p);
  const existing = await db.query("SELECT hash FROM saved_searches WHERE hash = ?", [hash]);
  if (existing.length === 0) {
    await db.run(
      `INSERT INTO saved_searches
         (hash, query, max_k, min_year, journal_filter, journal_name, title_keyword, author_keyword, jel, results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        p.query,
        p.maxK,
        p.minYear,
        p.journalFilter,
        p.journalName,
        p.titleKeyword,
        p.authorKeyword,
        p.jel,
        JSON.stringify(results),
      ],
    );
  }
  return hash;
}

export async function getSavedSearch(db: AppDataDb, hash: string): Promise<SavedSearch | null> {
  const rows = await db.query("SELECT * FROM saved_searches WHERE hash = ?", [hash]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    hash: String(r.hash),
    query: String(r.query),
    maxK: Number(r.max_k),
    minYear: optNum(r.min_year),
    journalFilter: optStr(r.journal_filter),
    journalName: optStr(r.journal_name),
    titleKeyword: optStr(r.title_keyword),
    authorKeyword: optStr(r.author_keyword),
    jel: optStr(r.jel),
    createdAt: String(r.created_at),
    results: JSON.parse(String(r.results)) as SemanticResult[],
  };
}

export interface SearchLogInput {
  ip: string;
  queryHash: string;
  resultCount: number;
  top3Handles: string[];
  flags: {
    hasYear: boolean;
    hasJournalFilter: boolean;
    hasJournalName: boolean;
    hasTitleKeyword: boolean;
    hasAuthorKeyword: boolean;
  };
  responseTimeMs: number;
}

export async function logSearch(db: AppDataDb, i: SearchLogInput): Promise<void> {
  const idRows = await db.query("SELECT nextval('search_logs_seq') AS id");
  const id = Number(idRows[0].id);
  const handles = i.top3Handles.slice(0, 3);
  // Build the VARCHAR[] inline via list_value(...) rather than binding a JS array — the
  // node-api list-bind path is unreliable, and the handles are already parameterised.
  const listSql = handles.length ? `list_value(${handles.map(() => "?").join(", ")})` : "[]::VARCHAR[]";
  await db.run(
    `INSERT INTO search_logs
       (search_id, ip, query_hash, result_count, top3_handles,
        has_year_filter, has_journal_filter, has_journal_name_filter,
        has_title_keyword, has_author_keyword, response_time_ms)
     VALUES (?, ?, ?, ?, ${listSql}, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      i.ip,
      i.queryHash,
      i.resultCount,
      ...handles,
      i.flags.hasYear,
      i.flags.hasJournalFilter,
      i.flags.hasJournalName,
      i.flags.hasTitleKeyword,
      i.flags.hasAuthorKeyword,
      i.responseTimeMs,
    ],
  );
}

export interface ClassicSearchStats {
  days: number;
  total_searches: number;
  avg_results: number | null;
  avg_response_ms: number | null;
  filter_usage: {
    year_filters: number;
    journal_filters: number;
    journal_name_filters: number;
    title_keyword_filters: number;
    author_keyword_filters: number;
  };
}

export async function getSearchStats(db: AppDataDb, days: number): Promise<ClassicSearchStats> {
  const window = "timestamp >= now() - to_days(CAST(? AS INTEGER))";
  const [totals] = await db.query(
    `SELECT COUNT(*) AS total, AVG(result_count) AS avg_results,
            AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) AS avg_ms
     FROM search_logs WHERE ${window}`,
    [days],
  );
  const [usage] = await db.query(
    `SELECT
       SUM(CASE WHEN has_year_filter THEN 1 ELSE 0 END)         AS year_filters,
       SUM(CASE WHEN has_journal_filter THEN 1 ELSE 0 END)      AS journal_filters,
       SUM(CASE WHEN has_journal_name_filter THEN 1 ELSE 0 END) AS journal_name_filters,
       SUM(CASE WHEN has_title_keyword THEN 1 ELSE 0 END)       AS title_keyword_filters,
       SUM(CASE WHEN has_author_keyword THEN 1 ELSE 0 END)      AS author_keyword_filters
     FROM search_logs WHERE ${window}`,
    [days],
  );
  return {
    days,
    total_searches: Number(totals?.total ?? 0),
    avg_results: optNum(totals?.avg_results),
    avg_response_ms: optNum(totals?.avg_ms),
    filter_usage: {
      year_filters: Number(usage?.year_filters ?? 0),
      journal_filters: Number(usage?.journal_filters ?? 0),
      journal_name_filters: Number(usage?.journal_name_filters ?? 0),
      title_keyword_filters: Number(usage?.title_keyword_filters ?? 0),
      author_keyword_filters: Number(usage?.author_keyword_filters ?? 0),
    },
  };
}

export interface SearchLogRow {
  search_id: number;
  timestamp: string;
  ip: string | null;
  query_hash: string | null;
  result_count: number | null;
  top3_handles: string[];
  has_year_filter: boolean | null;
  has_journal_filter: boolean | null;
  has_journal_name_filter: boolean | null;
  has_title_keyword: boolean | null;
  has_author_keyword: boolean | null;
  response_time_ms: number | null;
}

export async function searchLogsDay(db: AppDataDb, day: string): Promise<SearchLogRow[]> {
  const rows = await db.query(
    `SELECT * FROM search_logs
     WHERE timestamp >= CAST(? AS TIMESTAMP)
       AND timestamp <  CAST(? AS TIMESTAMP) + INTERVAL 1 DAY
     ORDER BY timestamp`,
    [day, day],
  );
  return rows.map((r) => ({
    search_id: Number(r.search_id),
    timestamp: String(r.timestamp),
    ip: optStr(r.ip),
    query_hash: optStr(r.query_hash),
    result_count: optNum(r.result_count),
    top3_handles: toStrList(r.top3_handles),
    has_year_filter: r.has_year_filter == null ? null : Boolean(r.has_year_filter),
    has_journal_filter: r.has_journal_filter == null ? null : Boolean(r.has_journal_filter),
    has_journal_name_filter: r.has_journal_name_filter == null ? null : Boolean(r.has_journal_name_filter),
    has_title_keyword: r.has_title_keyword == null ? null : Boolean(r.has_title_keyword),
    has_author_keyword: r.has_author_keyword == null ? null : Boolean(r.has_author_keyword),
    response_time_ms: optNum(r.response_time_ms),
  }));
}

// ── Person side (saved_person_searches + person_search_logs) — ports of save_person_search,
// get_saved_person_search, log_person_search, get_person_search_stats in pipeline/R. The save
// hash covers only {query, scoring_mode, quality_weight} (NOT the filters).

export interface SavedPersonSearchParams {
  query: string;
  scoringMode: string;
  qualityWeight: number;
}

export interface SavedPersonSearch extends SavedPersonSearchParams {
  hash: string;
  createdAt: string;
  results: unknown[];
}

export const personSaveHash = (p: SavedPersonSearchParams): string =>
  canonicalHash8(personSaveHashInput(p));

export async function savePersonSearch(
  db: AppDataDb,
  p: SavedPersonSearchParams,
  results: unknown[],
): Promise<string> {
  const hash = personSaveHash(p);
  const existing = await db.query("SELECT hash FROM saved_person_searches WHERE hash = ?", [hash]);
  if (existing.length === 0) {
    await db.run(
      `INSERT INTO saved_person_searches (hash, query, scoring_mode, quality_weight, results)
       VALUES (?, ?, ?, ?, ?)`,
      [hash, p.query, p.scoringMode, p.qualityWeight, JSON.stringify(results)],
    );
  }
  return hash;
}

export async function getSavedPersonSearch(db: AppDataDb, hash: string): Promise<SavedPersonSearch | null> {
  const rows = await db.query("SELECT * FROM saved_person_searches WHERE hash = ?", [hash]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    hash: String(r.hash),
    query: String(r.query),
    scoringMode: String(r.scoring_mode),
    qualityWeight: Number(r.quality_weight),
    createdAt: String(r.created_at),
    results: JSON.parse(String(r.results)) as unknown[],
  };
}

export interface PersonSearchLogInput {
  ip: string;
  queryHash: string;
  resultCount: number;
  top3ShortIds: string[];
  scoringMode: string;
  flags: {
    hasMinYear: boolean;
    hasCategory: boolean;
    hasInstitution: boolean;
    hasActiveSince: boolean;
    hasMinCitations: boolean;
  };
  responseTimeMs: number;
}

export async function logPersonSearch(db: AppDataDb, i: PersonSearchLogInput): Promise<void> {
  const idRows = await db.query("SELECT nextval('person_search_logs_seq') AS id");
  const id = Number(idRows[0].id);
  const ids = i.top3ShortIds.slice(0, 3);
  const listSql = ids.length ? `list_value(${ids.map(() => "?").join(", ")})` : "[]::VARCHAR[]";
  await db.run(
    `INSERT INTO person_search_logs
       (search_id, ip, query_hash, result_count, top3_short_ids, scoring_mode,
        has_min_year, has_category, has_institution, has_active_since, has_min_citations, response_time_ms)
     VALUES (?, ?, ?, ?, ${listSql}, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      i.ip,
      i.queryHash,
      i.resultCount,
      ...ids,
      i.scoringMode,
      i.flags.hasMinYear,
      i.flags.hasCategory,
      i.flags.hasInstitution,
      i.flags.hasActiveSince,
      i.flags.hasMinCitations,
      i.responseTimeMs,
    ],
  );
}

export interface PersonSearchStats {
  days: number;
  total_searches: number;
  avg_results: number | null;
  avg_response_ms: number | null;
  scoring_modes: { scoring_mode: string | null; n: number }[];
  filter_usage: {
    min_year_filters: number;
    category_filters: number;
    institution_filters: number;
    active_since_filters: number;
    min_citations_filters: number;
  };
}

export async function getPersonSearchStats(db: AppDataDb, days: number): Promise<PersonSearchStats> {
  const window = "timestamp >= now() - to_days(CAST(? AS INTEGER))";
  const [totals] = await db.query(
    `SELECT COUNT(*) AS total, AVG(result_count) AS avg_results,
            AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) AS avg_ms
     FROM person_search_logs WHERE ${window}`,
    [days],
  );
  const modes = await db.query(
    `SELECT scoring_mode, COUNT(*) AS n FROM person_search_logs WHERE ${window}
     GROUP BY scoring_mode ORDER BY n DESC`,
    [days],
  );
  const [usage] = await db.query(
    `SELECT
       SUM(CASE WHEN has_min_year THEN 1 ELSE 0 END)      AS min_year_filters,
       SUM(CASE WHEN has_category THEN 1 ELSE 0 END)      AS category_filters,
       SUM(CASE WHEN has_institution THEN 1 ELSE 0 END)   AS institution_filters,
       SUM(CASE WHEN has_active_since THEN 1 ELSE 0 END)  AS active_since_filters,
       SUM(CASE WHEN has_min_citations THEN 1 ELSE 0 END) AS min_citations_filters
     FROM person_search_logs WHERE ${window}`,
    [days],
  );
  return {
    days,
    total_searches: Number(totals?.total ?? 0),
    avg_results: optNum(totals?.avg_results),
    avg_response_ms: optNum(totals?.avg_ms),
    scoring_modes: modes.map((m) => ({ scoring_mode: optStr(m.scoring_mode), n: Number(m.n) })),
    filter_usage: {
      min_year_filters: Number(usage?.min_year_filters ?? 0),
      category_filters: Number(usage?.category_filters ?? 0),
      institution_filters: Number(usage?.institution_filters ?? 0),
      active_since_filters: Number(usage?.active_since_filters ?? 0),
      min_citations_filters: Number(usage?.min_citations_filters ?? 0),
    },
  };
}

export interface PersonSearchLogRow {
  search_id: number;
  timestamp: string;
  ip: string | null;
  query_hash: string | null;
  result_count: number | null;
  top3_short_ids: string[];
  scoring_mode: string | null;
  has_min_year: boolean | null;
  has_category: boolean | null;
  has_institution: boolean | null;
  has_active_since: boolean | null;
  has_min_citations: boolean | null;
  response_time_ms: number | null;
}

export async function personSearchLogsDay(db: AppDataDb, day: string): Promise<PersonSearchLogRow[]> {
  const rows = await db.query(
    `SELECT * FROM person_search_logs
     WHERE timestamp >= CAST(? AS TIMESTAMP)
       AND timestamp <  CAST(? AS TIMESTAMP) + INTERVAL 1 DAY
     ORDER BY timestamp`,
    [day, day],
  );
  return rows.map((r) => ({
    search_id: Number(r.search_id),
    timestamp: String(r.timestamp),
    ip: optStr(r.ip),
    query_hash: optStr(r.query_hash),
    result_count: optNum(r.result_count),
    top3_short_ids: toStrList(r.top3_short_ids),
    scoring_mode: optStr(r.scoring_mode),
    has_min_year: r.has_min_year == null ? null : Boolean(r.has_min_year),
    has_category: r.has_category == null ? null : Boolean(r.has_category),
    has_institution: r.has_institution == null ? null : Boolean(r.has_institution),
    has_active_since: r.has_active_since == null ? null : Boolean(r.has_active_since),
    has_min_citations: r.has_min_citations == null ? null : Boolean(r.has_min_citations),
    response_time_ms: optNum(r.response_time_ms),
  }));
}
