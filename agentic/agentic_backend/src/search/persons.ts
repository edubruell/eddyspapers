import { pipe } from "effect";
import * as A from "effect/Array";
import * as R from "remeda";
import type { CorpusDb } from "../db/corpus.js";
import { embedQuery, vectorLiteral } from "./embed.js";
import type { PersonResult, PersonSearchParams } from "./types.js";

// Port of the sandbox person_search verb (agentic/r/eddysearch.sandbox/R/person_verbs.R)
// — the read-only CTE re-implementation of the EconPeople two-stage rollup, per
// PLAN.md §A2 ("translate that, not the Plumber temp-table version"). Stage 1 SQL
// (hits → dedup → rolled → joined) stays verbatim; the dplyr scoring/filter tail
// becomes the pure pipeline at the bottom.

// @duckdb/node-api returns LIST columns as DuckDBListValue ({ items }); guard for
// plain arrays too so the fixture-DB tests don't depend on driver internals.
const toList = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v != null && typeof v === "object" && "items" in v ? ((v as { items: unknown[] }).items) : [];

type RolledRow = {
  short_id: string;
  name_full: string | null;
  workplace_name: string | null;
  workplace_institution: string | null;
  homepage: string | null;
  overlap_weight: number;
  n_matched: number;
  best_score: number;
  n_works_in_corpus: number | null;
  total_citations: number | null;
  first_year: number | null;
  last_year: number | null;
  primary_category: string | null;
  image_url: string | null;
  wikipedia_url: string | null;
  orcid: string | null;
  evidence: PersonResult["evidence"];
};

const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));

const rowToRolled = (r: Record<string, unknown>): RolledRow => {
  const titles = toList(r.evidence_titles);
  const journals = toList(r.evidence_journals);
  const years = toList(r.evidence_years);
  const scores = toList(r.evidence_scores);
  return {
    short_id: String(r.short_id),
    name_full: optStr(r.name_full),
    workplace_name: optStr(r.workplace_name),
    workplace_institution: optStr(r.workplace_institution),
    homepage: optStr(r.homepage),
    overlap_weight: Number(r.overlap_weight),
    n_matched: Number(r.n_matched),
    best_score: Number(r.best_score),
    n_works_in_corpus: optNum(r.n_works_in_corpus),
    total_citations: optNum(r.total_citations),
    first_year: optNum(r.first_year),
    last_year: optNum(r.last_year),
    primary_category: optStr(r.primary_category),
    image_url: optStr(r.image_url),
    wikipedia_url: optStr(r.wikipedia_url),
    orcid: optStr(r.orcid),
    evidence: toList(r.evidence_handles).map((handle, i) => ({
      handle: String(handle),
      title: optStr(titles[i]),
      journal: optStr(journals[i]),
      year: optNum(years[i]),
      score: Number(scores[i]),
    })),
  };
};

const scoreOf = (
  mode: "breadth" | "best_match" | "blended",
  r: RolledRow,
  qualityBlend: number,
  overlapNorm: number,
): number => {
  switch (mode) {
    case "best_match":
      return r.best_score * qualityBlend;
    case "blended":
      return (0.5 * overlapNorm + 0.5 * r.best_score) * qualityBlend;
    case "breadth":
      return r.overlap_weight * qualityBlend;
  }
};

export async function personSearch(db: CorpusDb, p: PersonSearchParams): Promise<PersonResult[]> {
  return personSearchWithVector(db, await embedQuery(p.query), p);
}

// Vector-supplied variant for tests and batch callers (mirrors semanticSearchWithVector).
export async function personSearchWithVector(
  db: CorpusDb,
  vec: number[],
  p: Omit<PersonSearchParams, "query">,
): Promise<PersonResult[]> {
  const mode = p.scoringMode ?? "breadth";
  const qualityWeight = p.qualityWeight ?? 0.3;

  const yearFilter = p.minYear != null ? ["a.year >= ?"] : [];
  const categoryFilter = p.journalFilter?.length
    ? [`a.category IN (${p.journalFilter.map(() => "?").join(", ")})`]
    : [];
  const filterSql = [...yearFilter, ...categoryFilter];
  const whereSql = filterSql.length ? `WHERE ${filterSql.join(" AND ")}` : "";
  const whereParams = [
    ...(p.minYear != null ? [p.minYear] : []),
    ...(p.journalFilter?.length ? p.journalFilter : []),
  ];

  const rows = await db.query(
    `WITH hits AS (
       SELECT LOWER(a.Handle) AS work_handle,
              a.title, a.journal, a.year,
              1 - array_cosine_distance(a.embeddings, ${vectorLiteral(vec)}) AS hit_score
       FROM articles a
       ${whereSql}
       ORDER BY hit_score DESC
       LIMIT ?
     ),
     dedup AS (
       SELECT work_handle, hit_score, title, journal, year
       FROM (
         SELECT h.*,
                ROW_NUMBER() OVER (
                  PARTITION BY LOWER(TRIM(COALESCE(title, work_handle)))
                  ORDER BY hit_score DESC
                ) AS rn
         FROM hits h
       ) t
       WHERE rn = 1
     ),
     rolled AS (
       SELECT pw.short_id,
              SUM(d.hit_score)                                    AS overlap_weight,
              COUNT(*)                                            AS n_matched,
              MAX(d.hit_score)                                    AS best_score,
              LIST(d.work_handle ORDER BY d.hit_score DESC)[1:5]  AS evidence_handles,
              LIST(d.title       ORDER BY d.hit_score DESC)[1:5]  AS evidence_titles,
              LIST(d.journal     ORDER BY d.hit_score DESC)[1:5]  AS evidence_journals,
              LIST(d.year        ORDER BY d.hit_score DESC)[1:5]  AS evidence_years,
              LIST(d.hit_score   ORDER BY d.hit_score DESC)[1:5]  AS evidence_scores
       FROM dedup d
       JOIN person_works pw ON pw.work_handle = d.work_handle
       GROUP BY pw.short_id
     )
     SELECT r.*, p.name_full, p.workplace_name, p.workplace_institution, p.homepage,
            ps.n_works_in_corpus, ps.total_citations,
            ps.first_year, ps.last_year, ps.primary_category,
            w.image_url, w.wikipedia_url, w.orcid
     FROM rolled r
     JOIN persons p ON p.short_id = r.short_id
     LEFT JOIN person_stats ps ON ps.short_id = r.short_id
     LEFT JOIN person_wikidata w ON w.short_id = r.short_id`,
    [...whereParams, p.kPapers ?? 600],
  );

  // Stage-2 post-filters, applied before the score normalisation maxima so the ranking
  // matches Plumber (institution is an exact case-insensitive equality, per search_persons).
  const institution = p.institution && p.institution.length > 0 ? p.institution.toLowerCase() : null;
  const candidates = pipe(
    rows,
    A.map(rowToRolled),
    A.filter(
      (r) => institution == null || (r.workplace_institution != null && r.workplace_institution.toLowerCase() === institution),
    ),
    A.filter((r) => p.activeSince == null || (r.last_year != null && r.last_year >= p.activeSince)),
    A.filter(
      (r) => p.minCitations == null || (r.total_citations != null && r.total_citations >= p.minCitations),
    ),
  );
  if (candidates.length === 0) return [];

  const maxLogCit = candidates.reduce((acc, r) => Math.max(acc, Math.log1p(r.total_citations ?? 0)), 0);
  const maxOverlap = candidates.reduce((acc, r) => Math.max(acc, r.overlap_weight), 0);

  return pipe(
    candidates,
    A.map((r): PersonResult => {
      const qualityNorm = maxLogCit > 0 ? Math.log1p(r.total_citations ?? 0) / maxLogCit : 0;
      const overlapNorm = maxOverlap > 0 ? r.overlap_weight / maxOverlap : 0;
      return {
        short_id: r.short_id,
        name_full: r.name_full,
        workplace_name: r.workplace_name,
        workplace_institution: r.workplace_institution,
        homepage: r.homepage,
        score: scoreOf(mode, r, 1 + qualityWeight * qualityNorm, overlapNorm),
        overlap_weight: r.overlap_weight,
        n_matched: r.n_matched,
        best_score: r.best_score,
        stats: {
          n_works_in_corpus: r.n_works_in_corpus,
          total_citations: r.total_citations,
          first_year: r.first_year,
          last_year: r.last_year,
          primary_category: r.primary_category,
        },
        wikidata: { image_url: r.image_url, wikipedia_url: r.wikipedia_url, orcid: r.orcid },
        evidence: r.evidence,
      };
    }),
    (results) => R.sortBy(results, [(r) => r.score, "desc"]),
    // offset+limit slice (Plumber paginates after scoring); offset defaults to 0, so the
    // MCP/sandbox callers that omit it get the same page-one behaviour as A.take once did.
    (results) => results.slice(p.offset ?? 0, (p.offset ?? 0) + (p.maxK ?? 25)),
  );
}
