import type { CorpusDb } from "../db/corpus.js";

// Person lookup / profile / papers — read-only ports of backend/R/persons.R
// (lookup_persons_by_name, get_person_profile, get_person_papers, handle_to_ideas_url),
// PLAN.md §A2. Wire fields are scalars (the M5 harness normalises Plumber's boxed goldens);
// the econpeople frontend reads these fields directly.

const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optStr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

export interface PersonLookupRow {
  short_id: string;
  name_full: string | null;
  workplace_name: string | null;
  n_works_in_corpus: number;
}

export async function lookupPersonsByName(
  db: CorpusDb,
  name: string,
  limit = 20,
): Promise<PersonLookupRow[]> {
  const rows = await db.query(
    `SELECT p.short_id, p.name_full, p.workplace_name,
            COALESCE(ps.n_works_in_corpus, 0) AS n_works_in_corpus
     FROM persons p
     LEFT JOIN person_stats ps ON ps.short_id = p.short_id
     WHERE LOWER(p.name_full) LIKE LOWER(?)
     ORDER BY COALESCE(ps.total_citations, 0) DESC
     LIMIT ?`,
    [`%${name}%`, limit],
  );
  return rows.map((r) => ({
    short_id: String(r.short_id),
    name_full: optStr(r.name_full),
    workplace_name: optStr(r.workplace_name),
    n_works_in_corpus: num(r.n_works_in_corpus),
  }));
}

export interface PersonProfile {
  short_id: string;
  name_full: string | null;
  name_first: string | null;
  name_last: string | null;
  workplace_name: string | null;
  workplace_institution: string | null;
  homepage: string | null;
  registered_date: string | null;
  stats: {
    n_works_total: number | null;
    n_works_in_corpus: number | null;
    total_citations: number | null;
    a_count: number | null;
    first_year: number | null;
    last_year: number | null;
    primary_category: string | null;
  };
  wikidata: Record<string, string | number | null> | null;
  editorial_roles: { series_handle: string; role: string | null; series_name: string | null; category: string | null }[];
  category_breakdown: { category: string | null; n: number }[];
  top_journals: { journal: string | null; n: number }[];
}

const WIKIDATA_FIELDS = [
  "wikidata_id",
  "wikipedia_url",
  "image_url",
  "birth_year",
  "birth_place",
  "citizenships",
  "educated_at",
  "doctoral_advisors",
  "doctoral_students",
  "fields_of_work",
  "memberships",
  "awards",
  "orcid",
  "google_scholar_id",
  "ssrn_author_id",
  "math_genealogy_id",
  "website",
] as const;

export async function personProfile(db: CorpusDb, shortId: string): Promise<PersonProfile | null> {
  const rows = await db.query(
    `SELECT p.short_id, p.name_full, p.name_first, p.name_last,
            p.workplace_name, p.workplace_institution, p.homepage, p.registered_date,
            ps.n_works_total, ps.n_works_in_corpus, ps.total_citations, ps.a_count,
            ps.first_year, ps.last_year, ps.primary_category,
            pw.wikidata_id, pw.wikipedia_url, pw.image_url, pw.birth_year, pw.birth_place,
            pw.citizenships, pw.educated_at, pw.doctoral_advisors, pw.doctoral_students,
            pw.fields_of_work, pw.memberships, pw.awards, pw.orcid, pw.google_scholar_id,
            pw.ssrn_author_id, pw.math_genealogy_id, pw.website
     FROM persons p
     LEFT JOIN person_stats ps ON ps.short_id = p.short_id
     LEFT JOIN person_wikidata pw ON pw.short_id = p.short_id
     WHERE p.short_id = ?`,
    [shortId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const [catBreakdown, topJournals, editorialRoles] = await Promise.all([
    db.query(
      `SELECT a.category, COUNT(*) AS n
       FROM person_works pw JOIN articles a ON LOWER(a.Handle) = pw.work_handle
       WHERE pw.short_id = ? GROUP BY a.category ORDER BY n DESC, a.category`,
      [shortId],
    ),
    db.query(
      `SELECT a.journal, COUNT(*) AS n
       FROM person_works pw JOIN articles a ON LOWER(a.Handle) = pw.work_handle
       WHERE pw.short_id = ? GROUP BY a.journal ORDER BY n DESC, a.journal LIMIT 5`,
      [shortId],
    ),
    db.query(
      `SELECT pw.work_handle AS series_handle, pw.work_type AS role, j.long_name AS series_name, j.category
       FROM person_works pw JOIN journals j ON j.series_handle = pw.work_handle
       WHERE pw.short_id = ? AND pw.work_type IN ('editor-series', 'editor-book')
       ORDER BY pw.work_type, series_name`,
      [shortId],
    ),
  ]);

  // wikidata is null unless the author has a wikidata_id (mirrors get_person_profile).
  const wikidata =
    r.wikidata_id == null
      ? null
      : Object.fromEntries(
          WIKIDATA_FIELDS.map((f) => [f, typeof r[f] === "bigint" ? Number(r[f]) : (r[f] ?? null)]),
        );

  return {
    short_id: String(r.short_id),
    name_full: optStr(r.name_full),
    name_first: optStr(r.name_first),
    name_last: optStr(r.name_last),
    workplace_name: optStr(r.workplace_name),
    workplace_institution: optStr(r.workplace_institution),
    homepage: optStr(r.homepage),
    registered_date: optStr(r.registered_date),
    stats: {
      n_works_total: optNum(r.n_works_total),
      n_works_in_corpus: optNum(r.n_works_in_corpus),
      total_citations: optNum(r.total_citations),
      a_count: optNum(r.a_count),
      first_year: optNum(r.first_year),
      last_year: optNum(r.last_year),
      primary_category: optStr(r.primary_category),
    },
    wikidata: wikidata as Record<string, string | number | null> | null,
    editorial_roles: editorialRoles.map((e) => ({
      series_handle: String(e.series_handle),
      role: optStr(e.role),
      series_name: optStr(e.series_name),
      category: optStr(e.category),
    })),
    category_breakdown: catBreakdown.map((c) => ({ category: optStr(c.category), n: num(c.n) })),
    top_journals: topJournals.map((t) => ({ journal: optStr(t.journal), n: num(t.n) })),
  };
}

const IDEAS_PREFIX: Record<string, string> = {
  paper: "p",
  article: "a",
  chapter: "h",
  book: "b",
  software: "e",
  "editor-book": "b",
  "editor-series": "s",
};

// repec:aea:aecrev:... + work_type -> https://ideas.repec.org/{prefix}/aea/aecrev/....html
export const handleToIdeasUrl = (handle: string, workType: string | null): string => {
  const prefix = (workType && IDEAS_PREFIX[workType]) || "p";
  const path = handle.replace(/^repec:/, "").replace(/:/g, "/");
  return `https://ideas.repec.org/${prefix}/${path}.html`;
};

export interface PersonPapers {
  short_id: string;
  counts: { total: number; in_corpus: number; out_of_corpus: number };
  in_corpus: Record<string, unknown>[];
  out_of_corpus: { work_handle: string; work_type: string | null; ideas_url: string }[];
}

export interface PersonPapersParams {
  sortBy?: "year" | "citations" | "journal";
  order?: "asc" | "desc";
  includeOutOfCorpus?: boolean;
  limit?: number;
  offset?: number;
}

export async function personPapers(
  db: CorpusDb,
  shortId: string,
  p: PersonPapersParams = {},
): Promise<PersonPapers> {
  const sortCol =
    p.sortBy === "citations" ? "hs.total_citations" : p.sortBy === "journal" ? "a.journal" : "a.year";
  const orderDir = (p.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const inCorpus = await db.query(
    `SELECT a.Handle AS handle, a.title, a.journal, a.year, a.category,
            a.abstract, a.bib_tex, a.authors, a.url, a.is_series,
            pw.work_type,
            COALESCE(hs.total_citations, 0) AS citations
     FROM person_works pw
     JOIN articles a ON LOWER(a.Handle) = pw.work_handle
     LEFT JOIN handle_stats hs ON LOWER(hs.handle) = pw.work_handle
     WHERE pw.short_id = ?
     ORDER BY ${sortCol} ${orderDir} NULLS LAST, a.Handle
     LIMIT ? OFFSET ?`,
    [shortId, p.limit ?? 50, p.offset ?? 0],
  );

  const [counts] = await db.query(
    `SELECT COUNT(*) AS n_total,
            SUM(CASE WHEN a.Handle IS NOT NULL THEN 1 ELSE 0 END) AS n_corpus
     FROM person_works pw
     LEFT JOIN articles a ON LOWER(a.Handle) = pw.work_handle
     WHERE pw.short_id = ?`,
    [shortId],
  );
  const total = num(counts?.n_total);
  const inCorpusCount = num(counts?.n_corpus);

  let outOfCorpus: PersonPapers["out_of_corpus"] = [];
  if (p.includeOutOfCorpus ?? true) {
    const ooc = await db.query(
      `SELECT pw.work_handle, pw.work_type
       FROM person_works pw
       LEFT JOIN articles a ON LOWER(a.Handle) = pw.work_handle
       WHERE pw.short_id = ? AND a.Handle IS NULL
       ORDER BY pw.work_handle`,
      [shortId],
    );
    outOfCorpus = ooc.map((o) => ({
      work_handle: String(o.work_handle),
      work_type: optStr(o.work_type),
      ideas_url: handleToIdeasUrl(String(o.work_handle), optStr(o.work_type)),
    }));
  }

  const inCorpusRows = inCorpus.map((r) => ({
    handle: String(r.handle),
    title: optStr(r.title),
    journal: optStr(r.journal),
    year: optNum(r.year),
    category: optStr(r.category),
    abstract: optStr(r.abstract),
    bib_tex: optStr(r.bib_tex),
    authors: optStr(r.authors),
    url: optStr(r.url),
    is_series: r.is_series == null ? null : Boolean(r.is_series),
    work_type: optStr(r.work_type),
    citations: num(r.citations),
  }));

  return {
    short_id: shortId,
    counts: { total, in_corpus: inCorpusCount, out_of_corpus: total - inCorpusCount },
    in_corpus: inCorpusRows,
    out_of_corpus: outOfCorpus,
  };
}
