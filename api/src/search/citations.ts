import type { CorpusDb } from "../db/corpus.js";
import { PAPER_COLS, rowToPaper } from "./papers.js";
import { hasOpenAlexTable } from "./openalex.js";
import type { PaperResult } from "./types.js";

// Citation / version / stats lookups against the corpus snapshot — the read-only
// ports of the sandbox data verbs (sandbox/eddysearch.sandbox/R/data_verbs.R).
// Phase 2 backs the paper-level MCP resources (01_design.md §7.6); Phase 5 reuses
// these same functions for the /cites, /citedby, /citationcounts, /handlestats and
// /versions REST route ports (PLAN.md §A2).
//
// The recurring hazard these encode: cit_internal / handle_stats / version_links
// store handles lowercase while articles.Handle is mixed case — every join lowers
// both sides (the LOWER-join bug fixed in the R verbs on 2026-07-10).

export type VersionRow = PaperResult & { type: string | null };

export type HandleStatsRow = Record<string, unknown>;

export type PaperOverview = {
  paper: PaperResult | null;
  stats: HandleStatsRow | null;
  versions: VersionRow[];
  openalex: OpenAlexStats | null;
};

export async function paperByHandle(db: CorpusDb, handle: string): Promise<PaperResult | null> {
  const rows = await db.query(
    `SELECT ${PAPER_COLS} FROM articles a WHERE LOWER(a.Handle) = LOWER(?)`,
    [handle],
  );
  return rows.length > 0 ? rowToPaper(rows[0]) : null;
}

export async function citesOf(db: CorpusDb, handle: string, limit = 50): Promise<PaperResult[]> {
  const rows = await db.query(
    `SELECT ${PAPER_COLS}
     FROM cit_internal ci
     JOIN articles a ON ci.cited = LOWER(a.Handle)
     WHERE ci.citing = LOWER(?)
     LIMIT ?`,
    [handle, limit],
  );
  return rows.map(rowToPaper);
}

export async function citedByOf(db: CorpusDb, handle: string, limit = 50): Promise<PaperResult[]> {
  const rows = await db.query(
    `SELECT ${PAPER_COLS}
     FROM cit_internal ci
     JOIN articles a ON ci.citing = LOWER(a.Handle)
     WHERE ci.cited = LOWER(?)
     LIMIT ?`,
    [handle, limit],
  );
  return rows.map(rowToPaper);
}

export async function handleStatsOf(db: CorpusDb, handle: string): Promise<HandleStatsRow | null> {
  const rows = await db.query("SELECT * FROM handle_stats WHERE handle = LOWER(?)", [handle]);
  return rows.length > 0 ? rows[0] : null;
}

// OpenAlex work-level metrics for one paper (M8 Wave 2 Track B, article_openalex). Distinct
// from handle_stats: those are RePEc-internal citation metrics; these are whole-literature
// OpenAlex numbers (global cited-by, FWCI, OA status, retraction) keyed on the same handle.
// `article_openalex.handle` carries the mixed-case corpus Handle, so LOWER-join both sides.
// The table only exists on Track-B+ snapshots (absent from older DBs and the test fixture),
// so guard on its presence rather than letting a catalog error escape — a missing table just
// means "no OpenAlex data", the same as a handle with no row.
export type OpenAlexStats = {
  openalex_id: string | null;
  oa_cited_by_count: number | null;
  fwci: number | null;
  pctl_value: number | null;
  is_top1: boolean | null;
  is_top10: boolean | null;
  is_retracted: boolean | null;
  is_oa: boolean | null;
  oa_status: string | null;
  oa_url: string | null;
  primary_topic: string | null;
  primary_field: string | null;
};

export async function openalexStatsOf(db: CorpusDb, handle: string): Promise<OpenAlexStats | null> {
  if (!(await hasOpenAlexTable(db))) return null;
  const rows = await db.query(
    `SELECT openalex_id, oa_cited_by_count, fwci, pctl_value, is_top1, is_top10,
            is_retracted, is_oa, oa_status, oa_url, primary_topic, primary_field
     FROM article_openalex WHERE LOWER(handle) = LOWER(?)`,
    [handle],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    openalex_id: optStr(r.openalex_id),
    oa_cited_by_count: optNum(r.oa_cited_by_count),
    fwci: optNum(r.fwci),
    pctl_value: optNum(r.pctl_value),
    is_top1: optBool(r.is_top1),
    is_top10: optBool(r.is_top10),
    is_retracted: optBool(r.is_retracted),
    is_oa: optBool(r.is_oa),
    oa_status: optStr(r.oa_status),
    oa_url: optStr(r.oa_url),
    primary_topic: optStr(r.primary_topic),
    primary_field: optStr(r.primary_field),
  };
}

export async function versionsOf(db: CorpusDb, handle: string): Promise<VersionRow[]> {
  // version_links(source, target, type) are directed edges; return the *other*
  // endpoint of every edge touching `handle`, joined to article metadata. The
  // queried handle is never returned as its own version.
  const rows = await db.query(
    `WITH links AS (
       SELECT CASE WHEN LOWER(source) = LOWER(?) THEN target ELSE source END AS related, type
       FROM version_links
       WHERE LOWER(source) = LOWER(?) OR LOWER(target) = LOWER(?)
     )
     SELECT COALESCE(a.Handle, l.related) AS Handle, l.type AS type,
            a.title, a.year, a.authors, a.journal, a.category, a.url, a.bib_tex, a.abstract
     FROM links l
     LEFT JOIN articles a ON LOWER(a.Handle) = LOWER(l.related)`,
    [handle, handle, handle],
  );
  return rows.map((r) => ({ ...rowToPaper(r), type: r.type == null ? null : String(r.type) }));
}

// ── Phase 5 REST wire variants (PLAN.md §A2) ──────────────────────────────────────────
// Distinct from the MCP fns above: these reproduce the Plumber SQL byte-for-byte —
// LEFT JOIN (out-of-corpus endpoints survive with null metadata), a lowercase `handle`
// key straight off the cit table, `is_series`, and `year DESC NULLS LAST` ordering. The
// MCP fns stay INNER JOIN + PaperResult shape; do not merge them.

export type CitationRow = {
  handle: string;
  title: string | null;
  year: number | null;
  authors: string | null;
  journal: string | null;
  category: string | null;
  is_series: boolean | null;
  url: string | null;
};

export type VersionLinkRow = {
  source: string;
  target: string;
  type: string | null;
  year: number | null;
  title: string | null;
  authors: string | null;
  journal: string | null;
  is_series: boolean | null;
  url: string | null;
};

export type CitationCounts = { total_citations: number; internal_citations: number };

const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));
const optBool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

const toCitationRow = (r: Record<string, unknown>): CitationRow => ({
  handle: String(r.handle),
  title: optStr(r.title),
  year: optNum(r.year),
  authors: optStr(r.authors),
  journal: optStr(r.journal),
  category: optStr(r.category),
  is_series: optBool(r.is_series),
  url: optStr(r.url),
});

// /citedby — papers that cite `handle` (join on ci.citing).
export async function citingPapersOf(db: CorpusDb, handle: string, limit = 50): Promise<CitationRow[]> {
  const rows = await db.query(
    `SELECT ci.citing AS handle, a.title, a.year, a.authors, a.journal, a.category, a.is_series, a.url
     FROM cit_internal ci
     LEFT JOIN articles a ON LOWER(ci.citing) = LOWER(a.Handle)
     WHERE LOWER(ci.cited) = LOWER(?)
     ORDER BY a.year DESC NULLS LAST, ci.citing
     LIMIT ?`,
    [handle, limit],
  );
  return rows.map(toCitationRow);
}

// /cites — papers cited by `handle` (join on ci.cited).
export async function citedPapersOf(db: CorpusDb, handle: string, limit = 50): Promise<CitationRow[]> {
  const rows = await db.query(
    `SELECT ci.cited AS handle, a.title, a.year, a.authors, a.journal, a.category, a.is_series, a.url
     FROM cit_internal ci
     LEFT JOIN articles a ON LOWER(ci.cited) = LOWER(a.Handle)
     WHERE LOWER(ci.citing) = LOWER(?)
     ORDER BY a.year DESC NULLS LAST, ci.cited
     LIMIT ?`,
    [handle, limit],
  );
  return rows.map(toCitationRow);
}

// /versions — directed version_links filtered to source = handle, target metadata joined
// (Plumber shape, keyed off `target`; not the bidirectional MCP versionsOf).
export async function versionLinksOf(db: CorpusDb, handle: string): Promise<VersionLinkRow[]> {
  const rows = await db.query(
    `SELECT vl.source, vl.target, vl.type, a.year, a.title, a.authors, a.journal, a.is_series, a.url
     FROM version_links vl
     LEFT JOIN articles a ON LOWER(vl.target) = LOWER(a.Handle)
     WHERE LOWER(vl.source) = LOWER(?)
     ORDER BY a.year DESC NULLS LAST, vl.target`,
    [handle],
  );
  return rows.map((r) => ({
    source: String(r.source),
    target: String(r.target),
    type: optStr(r.type),
    year: optNum(r.year),
    title: optStr(r.title),
    authors: optStr(r.authors),
    journal: optStr(r.journal),
    is_series: optBool(r.is_series),
    url: optStr(r.url),
  }));
}

// /citationcounts — total (cit_all) vs internal (cit_internal) inbound edges.
export async function citationCountsOf(db: CorpusDb, handle: string): Promise<CitationCounts> {
  const [total, internal] = await Promise.all([
    db.query("SELECT COUNT(*) AS n FROM cit_all WHERE LOWER(cited) = LOWER(?)", [handle]),
    db.query("SELECT COUNT(*) AS n FROM cit_internal WHERE LOWER(cited) = LOWER(?)", [handle]),
  ]);
  return {
    total_citations: Number(total[0]?.n ?? 0),
    internal_citations: Number(internal[0]?.n ?? 0),
  };
}

// The bundle backing agenticsearch://papers/{handle} — one paper record plus the
// precomputed handle_stats (total/internal citations, percentiles) and version
// links the old get_handle_stats / get_versions tools returned separately
// (01_design.md §7.6 "subsumes … into resources"). Total-vs-internal live counts
// off cit_all belong to the Phase 5 /citationcounts port, not this read.
//
// `openalex` carries the fuller OpenAlexStats shape (percentiles, top-1/10%) rather than the
// lean block that rides on search-result papers — this is the detail view, so it mirrors what
// /openalexstats surfaces on the classic card. Null on pre-Track-B snapshots or unmatched works.
export async function paperOverview(db: CorpusDb, handle: string): Promise<PaperOverview> {
  const [paper, stats, versions, openalex] = await Promise.all([
    paperByHandle(db, handle),
    handleStatsOf(db, handle),
    versionsOf(db, handle),
    openalexStatsOf(db, handle),
  ]);
  return { paper, stats, versions, openalex };
}
