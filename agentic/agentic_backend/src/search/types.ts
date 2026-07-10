// Wire shapes for the search core (PLAN.md §3–4). PaperResult mirrors the Plumber
// /search row so the parity harness and, later, the Phase 5 route ports can diff
// responses field-for-field.

export type PaperResult = {
  Handle: string;
  title: string | null;
  year: number | null;
  authors: string | null;
  journal: string | null;
  category: string | null;
  url: string | null;
  bib_tex: string | null;
  abstract: string | null;
};

export type SemanticResult = PaperResult & {
  similarity: number;
  similarity_score: number;
};

export type SemanticParams = {
  query: string;
  maxK?: number;
  minYear?: number | null;
  journalFilter?: string[] | null;
  journalName?: string[] | null;
  titleKeyword?: string | null;
  authorKeyword?: string | null;
};

export type KeywordField = "title" | "abstract" | "authors";

export type KeywordParams = {
  keywords: string[];
  fields?: KeywordField[];
  match?: "any" | "all";
  minYear?: number | null;
  maxYear?: number | null;
  categories?: string[] | null;
  journalName?: string[] | null;
  orderBy?: "year" | "citations";
  limit?: number;
  offset?: number;
};

export type KeywordSearchResult = {
  total: number;
  results: PaperResult[];
};

export type BibEntry = {
  cite_key?: string | null;
  handle?: string | null;
  author_lastnames?: string | null;
  year?: number | null;
  title?: string | null;
  journal?: string | null;
};

export type VerifyStatus = "handle_match" | "fuzzy_match" | "loose_match" | "not_found";

export type VerifyMismatch =
  | { kind: "year"; entry: number; db: number }
  | { kind: "journal"; entry: string; db: string };

export type VerifiedEntry = {
  entry: BibEntry;
  status: VerifyStatus;
  paper: PaperResult | null;
  stats: {
    citation_percentile: number | null;
    total_citations: number | null;
    citations_per_year: number | null;
  } | null;
  mismatches: VerifyMismatch[];
};

export type ScoringMode = "breadth" | "best_match" | "blended";

export type PersonSearchParams = {
  query: string;
  maxK?: number;
  kPapers?: number;
  scoringMode?: ScoringMode;
  qualityWeight?: number;
  minYear?: number | null;
  journalFilter?: string[] | null;
  activeSince?: number | null;
  minCitations?: number | null;
};

export type PersonEvidence = {
  handle: string;
  title: string | null;
  journal: string | null;
  year: number | null;
  score: number;
};

export type PersonResult = {
  short_id: string;
  name_full: string | null;
  workplace_name: string | null;
  homepage: string | null;
  score: number;
  overlap_weight: number;
  n_matched: number;
  best_score: number;
  stats: {
    n_works_in_corpus: number | null;
    total_citations: number | null;
    first_year: number | null;
    last_year: number | null;
    primary_category: string | null;
  };
  wikidata: {
    image_url: string | null;
    wikipedia_url: string | null;
    orcid: string | null;
  };
  evidence: PersonEvidence[];
};
