import type { CorpusDb } from "../db/corpus.js";

// The "context tooling" payload (PLAN.md §B3/§C3): everything a consuming model
// needs to use the corpus well — real filter values, sizes, snapshot age, and the
// query-writing doctrine lifted from the lit-search skill. Served at /corpus/guide
// and mirrored by the MCP corpus_context tool in Phase 2.

export type CorpusGuide = {
  snapshot_date: string | null;
  total_articles: number;
  total_persons: number;
  categories: { category: string; n: number; example_journals: string[] }[];
  person_scoring_modes: string[];
  semantic_query_guidance: string;
  keyword_search_guidance: string;
  default_category_mix: string[];
};

const SEMANTIC_DOCTRINE = `Write semantic queries as 3-6 sentences of abstract-style prose, not topic labels. Describe the mechanism or phenomenon studied; include method words if relevant (quasi-experimental, RCT, IV, matched panel) and context if relevant (country, population, data source). Vary the framing across queries to explore different facets. Bad: "bureaucratic quality immigration". Good: "How the quality of local public administration shapes immigrant outcomes. Causal effects of processing speed, staff discretion, and service quality at immigration offices on migrants' labour market integration and settlement decisions."`;

const KEYWORD_DOCTRINE = `Use keyword search for exhaustive term sweeps and known-phrase lookups (title is the default field; abstract/authors optional). Keywords are OR-ed by default (match="any"); combine with category and year filters to keep result sets reviewable. Order by "citations" to surface established work, "year" for recency.`;

// The default filter mix the lit-search skill converged on ("works well for most
// searches") — exposed so calling models don't have to rediscover it.
const DEFAULT_CATEGORY_MIX = [
  "Top 5 Journals",
  "General Interest",
  "AEJs",
  "Top Field Journals (A)",
  "Second in Field Journals (B)",
];

const buildGuide = async (db: CorpusDb): Promise<CorpusGuide> => {
  const [meta, totals, personTotals, categories, topJournals] = await Promise.all([
    db.query("SELECT value FROM db_metadata WHERE key = 'last_content_update'"),
    db.query("SELECT COUNT(*) AS n FROM articles"),
    db.query("SELECT COUNT(*) AS n FROM persons"),
    db.query(
      "SELECT category, COUNT(*) AS n FROM articles WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC",
    ),
    db.query(
      `SELECT category, journal FROM (
         SELECT category, journal, ROW_NUMBER() OVER (
           PARTITION BY category ORDER BY COUNT(*) DESC
         ) AS rn
         FROM articles
         WHERE category IS NOT NULL AND journal IS NOT NULL
         GROUP BY category, journal
       ) WHERE rn <= 8`,
    ),
  ]);

  const journalsByCategory = topJournals.reduce<Record<string, string[]>>(
    (acc, r) => ({
      ...acc,
      [String(r.category)]: [...(acc[String(r.category)] ?? []), String(r.journal)],
    }),
    {},
  );

  return {
    snapshot_date: meta.length > 0 ? String(meta[0].value) : null,
    total_articles: Number(totals[0]?.n ?? 0),
    total_persons: Number(personTotals[0]?.n ?? 0),
    categories: categories.map((r) => ({
      category: String(r.category),
      n: Number(r.n),
      example_journals: journalsByCategory[String(r.category)] ?? [],
    })),
    person_scoring_modes: ["breadth", "best_match", "blended"],
    semantic_query_guidance: SEMANTIC_DOCTRINE,
    keyword_search_guidance: KEYWORD_DOCTRINE,
    default_category_mix: DEFAULT_CATEGORY_MIX,
  };
};

// Cached per process: the corpus is immutable between snapshot swaps, and a swap
// restarts the service today (PLAN.md §11.4 — revisit if hot-reload lands). A
// failed build clears the cache so a transient DB error doesn't stick until restart.
let cached: Promise<CorpusGuide> | null = null;

export function corpusGuide(db: CorpusDb): Promise<CorpusGuide> {
  if (!cached) {
    cached = buildGuide(db).catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

// Drop the memoised guide so the next request rebuilds it against a freshly-swapped corpus
// snapshot. Called by reloadCorpusDb() (POST /admin/reload) — the snapshot's article/journal
// counts and last_updated date change on a pipeline swap.
export function clearGuideCache(): void {
  cached = null;
}
