import { createHash } from "crypto";

// Deterministic 8-char hashes for saved searches (PLAN.md §6 decision 2). The old
// Plumber hashes were the first 8 chars of an xxhash64 over a *serialised R object* —
// byte-parity from Node is unreachable and unnecessary (the parity harness compares
// results, never hash values). We standardise on SHA-256 over canonical JSON, matching
// the pattern already used for computeSearchId / key hashing: `crypto` is built-in, and
// same params → same hash still holds within the Node era, preserving dedup semantics.
// Old hashes stay resolvable because the row migration copies them verbatim.

export const canonicalHash8 = (fields: Array<[string, unknown]>): string => {
  // Fixed key order in, so the JSON is canonical; absent params carry through as null.
  const canonical = JSON.stringify(fields.map(([, v]) => (v === undefined ? null : v)));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
};

// The classic /search hash covers all seven request params (mirrors generate_search_hash
// in the retired Plumber api.R). Raw comma-strings are hashed as received, not the split arrays.
export const searchHashInput = (p: {
  query: string;
  maxK: number;
  minYear: number | null;
  journalFilter: string | null;
  journalName: string | null;
  titleKeyword: string | null;
  authorKeyword: string | null;
}): Array<[string, unknown]> => [
  ["query", p.query],
  ["max_k", p.maxK],
  ["min_year", p.minYear],
  ["journal_filter", p.journalFilter],
  ["journal_name", p.journalName],
  ["title_keyword", p.titleKeyword],
  ["author_keyword", p.authorKeyword],
];

// The person save hash covers only {query, scoring_mode, quality_weight} — NOT the filters
// (mirrors save_person_search in the retired Plumber persons.R, distinct from the person *log* hash).
export const personSaveHashInput = (p: {
  query: string;
  scoringMode: string;
  qualityWeight: number;
}): Array<[string, unknown]> => [
  ["query", p.query],
  ["scoring_mode", p.scoringMode],
  ["quality_weight", p.qualityWeight],
];
