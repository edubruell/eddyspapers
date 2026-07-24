import { pipe } from "effect";
import * as A from "effect/Array";
import type { CorpusDb } from "../db/corpus.js";
import { embedQuery, vectorLiteral } from "./embed.js";
import type {
  BibEntry,
  KeywordField,
  KeywordParams,
  KeywordSearchResult,
  PaperResult,
  SemanticParams,
  SemanticResult,
  VerifiedEntry,
  VerifyMismatch,
} from "./types.js";

// Exported so citations.ts (paper-level MCP resources + Phase 5 citation route
// ports) selects and maps the same article columns without redefining them.
export const PAPER_COLS =
  "a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url, a.doi, a.bib_tex, a.abstract";

// Filter fragments carry their bind values with them so WHERE assembly stays a
// pure fold and user input never lands in the SQL string (the Plumber version
// interpolated with sprintf). One deliberate divergence: we escape LIKE
// wildcards, Plumber does not — a literal "%"/"_" in a keyword behaves
// differently across stacks (ours is the correct reading; note for the Phase 5
// dual-run diff).
type Fragment = { sql: string; params: unknown[] };

const frag = (sql: string, ...params: unknown[]): Fragment => ({ sql, params });

// Parameterisation stops injection but not LIKE wildcards — a literal "%" or "_"
// in a keyword must not blow the match open. Every LIKE in this module pairs a
// likeParam() value with the LIKE_ESC clause.
export const LIKE_ESC = "ESCAPE '\\'";

const likeParam = (needle: string): string =>
  `%${needle.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

const anyOf = (fragments: Fragment[]): Fragment => ({
  sql: `(${fragments.map((f) => f.sql).join(" OR ")})`,
  params: fragments.flatMap((f) => f.params),
});

const whereClause = (fragments: Fragment[]): Fragment =>
  fragments.length === 0
    ? frag("")
    : {
        sql: `WHERE ${fragments.map((f) => f.sql).join(" AND ")}`,
        params: fragments.flatMap((f) => f.params),
      };

export const rowToPaper = (r: Record<string, unknown>): PaperResult => ({
  Handle: String(r.Handle),
  title: (r.title as string | null) ?? null,
  year: r.year == null ? null : Number(r.year),
  authors: (r.authors as string | null) ?? null,
  journal: (r.journal as string | null) ?? null,
  category: (r.category as string | null) ?? null,
  url: (r.url as string | null) ?? null,
  doi: (r.doi as string | null) ?? null,
  bib_tex: (r.bib_tex as string | null) ?? null,
  abstract: (r.abstract as string | null) ?? null,
});

// JEL inputs are codes or prefixes ("J31", "J3"); prefix LIKE covers both since
// codes cap at letter+2 digits. Uppercase + shape-check here so raw callers
// can't smuggle LIKE wildcards; invalid entries are dropped (an invalid code
// can never match anyway — absence of JEL rows means unknown, not excluded).
const jelCodes = (jel: string[] | null | undefined): string[] =>
  (jel ?? [])
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]\d{0,2}$/.test(c));

const jelFragment = (codes: string[]): Fragment => ({
  sql: `EXISTS (SELECT 1 FROM article_jel j
        WHERE j.handle = LOWER(a.Handle)
          AND (${codes.map(() => "j.jel_code LIKE ?").join(" OR ")}))`,
  params: codes.map((c) => `${c}%`),
});

// Shared by semantic + person search: the row filters Plumber's /search supports.
export const paperFilters = (p: {
  minYear?: number | null;
  journalFilter?: string[] | null;
  journalName?: string[] | null;
  titleKeyword?: string | null;
  authorKeyword?: string | null;
  jel?: string[] | null;
}): Fragment[] =>
  pipe(
    [
      p.minYear != null ? frag("a.year >= ?", p.minYear) : null,
      p.journalFilter?.length
        ? frag(`a.category IN (${p.journalFilter.map(() => "?").join(", ")})`, ...p.journalFilter)
        : null,
      p.journalName?.length
        ? anyOf(p.journalName.map((j) => frag(`LOWER(a.journal) LIKE ? ${LIKE_ESC}`, likeParam(j))))
        : null,
      p.titleKeyword ? frag(`LOWER(a.title) LIKE ? ${LIKE_ESC}`, likeParam(p.titleKeyword)) : null,
      p.authorKeyword ? frag(`LOWER(a.authors) LIKE ? ${LIKE_ESC}`, likeParam(p.authorKeyword)) : null,
      jelCodes(p.jel).length ? jelFragment(jelCodes(p.jel)) : null,
    ],
    A.filter((f): f is Fragment => f !== null),
  );

export async function semanticSearch(db: CorpusDb, p: SemanticParams): Promise<SemanticResult[]> {
  return semanticSearchWithVector(db, await embedQuery(p.query), p);
}

// Split from semanticSearch so tests (and later batch callers) can supply a
// precomputed vector — no Ollama in the test path.
export async function semanticSearchWithVector(
  db: CorpusDb,
  vec: number[],
  p: Omit<SemanticParams, "query">,
): Promise<SemanticResult[]> {
  const where = whereClause(paperFilters(p));

  const rows = await db.query(
    `SELECT ${PAPER_COLS},
            array_cosine_distance(a.embeddings, ${vectorLiteral(vec)}) AS similarity
     FROM articles a
     ${where.sql}
     ORDER BY similarity ASC
     LIMIT ?`,
    [...where.params, p.maxK ?? 100],
  );

  // similarity_score is unrounded here; the Plumber endpoint rounds to 5 digits
  // before serialising — the Phase 5 /search route port must add that rounding
  // for byte-level wire parity.
  return rows.map((r) => ({
    ...rowToPaper(r),
    similarity: Number(r.similarity),
    similarity_score: 1 - Number(r.similarity),
  }));
}

const KEYWORD_COLUMNS: Record<KeywordField, string> = {
  title: "a.title",
  abstract: "a.abstract",
  authors: "a.authors",
};

const keywordFragment = (fields: KeywordField[]) => (kw: string): Fragment =>
  anyOf(fields.map((f) => frag(`LOWER(${KEYWORD_COLUMNS[f]}) LIKE ? ${LIKE_ESC}`, likeParam(kw))));

export async function keywordSearch(db: CorpusDb, p: KeywordParams): Promise<KeywordSearchResult> {
  // Guard here, not only in the route's zod schema: Phase 2 MCP tools call this
  // directly, and an empty list otherwise surfaces as a raw DuckDB parse error.
  const keywords = p.keywords.map((k) => k.trim()).filter(Boolean);
  if (keywords.length === 0) {
    throw new Error("keywordSearch requires at least one non-empty keyword");
  }
  const fields = p.fields?.length ? p.fields : (["title"] as KeywordField[]);
  const perKeyword = keywords.map(keywordFragment(fields));
  const keywordBlock =
    p.match === "all"
      ? { sql: `(${perKeyword.map((f) => f.sql).join(" AND ")})`, params: perKeyword.flatMap((f) => f.params) }
      : anyOf(perKeyword);

  const where = whereClause([
    keywordBlock,
    ...paperFilters({ minYear: p.minYear, journalFilter: p.categories, journalName: p.journalName, jel: p.jel }),
    ...(p.maxYear != null ? [frag("a.year <= ?", p.maxYear)] : []),
  ]);

  // Handle tiebreak makes OFFSET pagination deterministic (year alone has ties).
  const orderBy =
    p.orderBy === "citations"
      ? "ORDER BY COALESCE(hs.total_citations, 0) DESC, a.year DESC, a.Handle"
      : "ORDER BY a.year DESC, a.Handle";
  // handle_stats.handle is stored lowercase; articles.Handle is mixed case.
  const statsJoin =
    p.orderBy === "citations" ? "LEFT JOIN handle_stats hs ON hs.handle = LOWER(a.Handle)" : "";

  const [countRows, rows] = await Promise.all([
    db.query(`SELECT COUNT(*) AS n FROM articles a ${where.sql}`, where.params),
    db.query(
      `SELECT ${PAPER_COLS} FROM articles a ${statsJoin} ${where.sql} ${orderBy} LIMIT ? OFFSET ?`,
      [...where.params, p.limit ?? 100, p.offset ?? 0],
    ),
  ]);

  return { total: Number(countRows[0]?.n ?? 0), results: rows.map(rowToPaper) };
}

// --- verifyReferences: the lit-check three-tier matcher (localwip/lit-check/SKILL.md) ---

const TITLE_STOPWORDS = new Set(["their", "which", "these", "those", "about", "between", "through"]);

// First substantive word (>=5 chars, not a stopword); fall back to any word >=4 chars.
// Exported for tests — the extraction quality decides tier-2 hit rates.
export const extractTitleKeyword = (title: string): string | null => {
  const words = title.match(/[A-Za-z]{5,}/g) ?? [];
  const substantive = words.find((w) => !TITLE_STOPWORDS.has(w.toLowerCase()));
  if (substantive) return substantive;
  return title.match(/\w{4,}/)?.[0] ?? null;
};

export const firstAuthorLastname = (lastnames: string): string | null => {
  const first = lastnames.split(";")[0]?.trim();
  return first ? first : null;
};

const firstTwoTitleWords = (title: string): string | null => {
  const m = title.trim().match(/^\S+\s+\S+/);
  return m ? m[0] : null;
};

const lookupPaper = async (db: CorpusDb, sql: string, params: unknown[]): Promise<PaperResult | null> => {
  const rows = await db.query(sql, params);
  return rows.length > 0 ? rowToPaper(rows[0]) : null;
};

const matchEntry = async (
  db: CorpusDb,
  e: BibEntry,
): Promise<{ status: VerifiedEntry["status"]; paper: PaperResult | null }> => {
  // Tier 1: direct handle lookup. LOWER() on both sides — RePEc handles are
  // case-insensitive identifiers but stored mixed-case ("RePEc:aea:..."). Note:
  // LOWER(Handle) defeats any index, so each entry costs a scan; fine at the
  // 200-entry route cap, revisit before higher-volume MCP exposure.
  if (e.handle) {
    const paper = await lookupPaper(
      db,
      `SELECT ${PAPER_COLS} FROM articles a WHERE LOWER(a.Handle) = LOWER(?)`,
      [e.handle],
    );
    if (paper) return { status: "handle_match", paper };
  }

  const author = e.author_lastnames ? firstAuthorLastname(e.author_lastnames) : null;
  if (!author || e.year == null || !e.title) return { status: "not_found", paper: null };

  // Tier 2: exact year + first author + one substantive title keyword.
  const titleKw = extractTitleKeyword(e.title);
  if (titleKw) {
    const paper = await lookupPaper(
      db,
      `SELECT ${PAPER_COLS} FROM articles a
       WHERE a.year = ? AND LOWER(a.authors) LIKE ? ${LIKE_ESC} AND LOWER(a.title) LIKE ? ${LIKE_ESC}
       LIMIT 5`,
      [e.year, likeParam(author), likeParam(titleKw)],
    );
    if (paper) return { status: "fuzzy_match", paper };
  }

  // Tier 3: year +/- 1, same author, first two title words.
  const shortKw = firstTwoTitleWords(e.title);
  if (shortKw) {
    const paper = await lookupPaper(
      db,
      `SELECT ${PAPER_COLS} FROM articles a
       WHERE a.year BETWEEN ? AND ? AND LOWER(a.authors) LIKE ? ${LIKE_ESC} AND LOWER(a.title) LIKE ? ${LIKE_ESC}
       LIMIT 5`,
      [e.year - 1, e.year + 1, likeParam(author), likeParam(shortKw)],
    );
    if (paper) return { status: "loose_match", paper };
  }

  return { status: "not_found", paper: null };
};

const entryMismatches = (e: BibEntry, paper: PaperResult): VerifyMismatch[] =>
  pipe(
    [
      e.year != null && paper.year != null && Math.abs(e.year - paper.year) > 1
        ? ({ kind: "year", entry: e.year, db: paper.year } as VerifyMismatch)
        : null,
      e.journal &&
      paper.journal &&
      !paper.journal.toLowerCase().includes(e.journal.toLowerCase()) &&
      !e.journal.toLowerCase().includes(paper.journal.toLowerCase())
        ? ({ kind: "journal", entry: e.journal, db: paper.journal } as VerifyMismatch)
        : null,
    ],
    A.filter((m): m is VerifyMismatch => m !== null),
  );

const entryStats = async (db: CorpusDb, handle: string): Promise<VerifiedEntry["stats"]> => {
  const rows = await db.query(
    // handle_stats.handle is stored lowercase; articles.Handle is mixed case.
    "SELECT citation_percentile, total_citations, citations_per_year FROM handle_stats WHERE handle = LOWER(?)",
    [handle],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    citation_percentile: r.citation_percentile == null ? null : Number(r.citation_percentile),
    total_citations: r.total_citations == null ? null : Number(r.total_citations),
    citations_per_year: r.citations_per_year == null ? null : Number(r.citations_per_year),
  };
};

export async function verifyReferences(db: CorpusDb, entries: BibEntry[]): Promise<VerifiedEntry[]> {
  // Sequential on purpose: batches arrive tens-of-entries sized and each entry is
  // 1-3 indexed lookups; parallelising would just contend for the small pool.
  const out: VerifiedEntry[] = [];
  for (const entry of entries) {
    const { status, paper } = await matchEntry(db, entry);
    out.push({
      entry,
      status,
      paper,
      stats: paper ? await entryStats(db, paper.Handle) : null,
      mismatches: paper ? entryMismatches(entry, paper) : [],
    });
  }
  return out;
}
