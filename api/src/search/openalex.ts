import type { CorpusDb } from "../db/corpus.js";

// Per-paper OpenAlex metrics (M8 Wave 2 Track B, article_openalex) attached to the shared
// PaperResult so every search surface — find_papers, keyword_search, verify_references —
// carries the same whole-literature signals (global cited-by, FWCI, retraction, OA link)
// without each query redefining the projection. Distinct from handle_stats (RePEc-internal
// citations) and from openalexStatsOf's fuller REST shape in citations.ts; this is the lean
// block an agent acts on. article_openalex.handle is the mixed-case corpus Handle → LOWER-join.
//
// The table only exists on Track-B+ snapshots (absent from older DBs). We resolve its
// presence ONCE per corpus handle (cached below) rather than probing information_schema per
// query; a missing table simply means "no OpenAlex data", the same as a handle with no row.

export type OpenAlexPaperMetrics = {
  openalex_id: string;
  oa_cited_by_count: number | null;
  fwci: number | null;
  is_retracted: boolean | null;
  is_oa: boolean | null;
  oa_url: string | null;
  oa_status: string | null;
  primary_topic: string | null;
  primary_field: string | null;
};

const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));
const optBool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

// Presence is a property of the snapshot, so cache it keyed on the CorpusDb instance. A
// pipeline swap (/admin/reload) mints a fresh CorpusDb, so the stale entry is GC'd with the
// closed instance and the new one re-probes — no explicit invalidation needed.
const tablePresence = new WeakMap<CorpusDb, Promise<boolean>>();

export function hasOpenAlexTable(db: CorpusDb): Promise<boolean> {
  const cached = tablePresence.get(db);
  if (cached) return cached;
  const probe = db
    .query("SELECT 1 FROM information_schema.tables WHERE table_name = 'article_openalex' LIMIT 1")
    .then((rows) => rows.length > 0)
    .catch(() => false);
  tablePresence.set(db, probe);
  return probe;
}

// A SELECT over `articles a` opts into the metrics by appending OPENALEX_COLS and OPENALEX_JOIN.
// A row exists only for matched works, so openalex_id is non-null whenever there is data.
export const OPENALEX_COLS =
  "ox.openalex_id, ox.oa_cited_by_count, ox.fwci, ox.is_retracted, ox.is_oa, " +
  "ox.oa_url, ox.oa_status, ox.primary_topic, ox.primary_field";

export const OPENALEX_JOIN =
  "LEFT JOIN article_openalex ox ON LOWER(ox.handle) = LOWER(a.Handle)";

// Null openalex_id ⇒ either the join wasn't present (pre-Track-B snapshot) or no matched
// work for this handle; both mean "no OpenAlex data".
export const rowToOpenAlex = (r: Record<string, unknown>): OpenAlexPaperMetrics | null =>
  r.openalex_id == null
    ? null
    : {
        openalex_id: String(r.openalex_id),
        oa_cited_by_count: optNum(r.oa_cited_by_count),
        fwci: optNum(r.fwci),
        is_retracted: optBool(r.is_retracted),
        is_oa: optBool(r.is_oa),
        oa_url: optStr(r.oa_url),
        oa_status: optStr(r.oa_status),
        primary_topic: optStr(r.primary_topic),
        primary_field: optStr(r.primary_field),
      };
