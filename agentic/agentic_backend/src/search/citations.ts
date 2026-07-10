import type { CorpusDb } from "../db/corpus.js";
import { PAPER_COLS, rowToPaper } from "./papers.js";
import type { PaperResult } from "./types.js";

// Citation / version / stats lookups against the corpus snapshot — the read-only
// ports of the sandbox data verbs (agentic/r/eddysearch.sandbox/R/data_verbs.R).
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

// The bundle backing agenticsearch://papers/{handle} — one paper record plus the
// precomputed handle_stats (total/internal citations, percentiles) and version
// links the old get_handle_stats / get_versions tools returned separately
// (01_design.md §7.6 "subsumes … into resources"). Total-vs-internal live counts
// off cit_all belong to the Phase 5 /citationcounts port, not this read.
export async function paperOverview(db: CorpusDb, handle: string): Promise<PaperOverview> {
  const [paper, stats, versions] = await Promise.all([
    paperByHandle(db, handle),
    handleStatsOf(db, handle),
    versionsOf(db, handle),
  ]);
  return { paper, stats, versions };
}
