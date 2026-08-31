import { ALL_SCOPES, type Scope } from "../db/appdata.js";
import { MCP_TOOL_NAMES } from "../mcp/tools.js";

// One source of truth for the input conventions a caller cannot guess from a type alone.
// Both faces import from here — the MCP tools spend them as per-field `.describe()` text and
// the REST reference (GET /docs) serves them verbatim — so a convention can never be
// documented on one surface and silently missing on the other. Every entry here exists
// because someone got it wrong: `author_lastnames` was semicolon-separated with the rule
// buried in a private skill file, and the first external API user hit exactly that.

export const FIELD_DOCS = {
  authorLastnames:
    "Author LAST NAMES ONLY, SEMICOLON-separated — e.g. \"Acemoglu; Johnson; Robinson\". " +
    "Not comma-separated (a comma is read as part of a single name), no first names, no " +
    "initials, no \"and\"/\"&\". One author is fine. Matching only ever needs the first name " +
    "in the list, so a truncated author list still verifies.",
  handle:
    "RePEc handle, e.g. \"RePEc:aea:aecrev:v:110:y:2020:i:6:p:1797-1823\". When given it is " +
    "tried first and an exact hit short-circuits the fuzzy tiers.",
  citeKey: "Your own BibTeX cite key. Echoed back untouched so you can join results to your .bib.",
  entryYear:
    "Publication year as an integer, not a string. Tier 2 requires an exact match; tier 3 " +
    "accepts year ±1, which is how a working paper and its journal version reconcile.",
  entryTitle:
    "Full title as plain text. Tier 2 matches on a distinctive title keyword, tier 3 on the " +
    "first two words — so a lightly mistyped title still matches, a truncated one may not.",
  entryJournal:
    "Journal or series name. Never used to match; only compared against the matched paper to " +
    "raise a journal mismatch flag.",
  semanticQuery:
    "3-6 sentences of abstract-style PROSE describing the mechanism, method, data and context " +
    "you want — not keyword labels. Good: \"Causal effects of minimum wage increases on " +
    "low-wage employment, using border-discontinuity and synthetic-control designs across US " +
    "states.\" Bad: \"minimum wage employment\". This single choice drives result quality more " +
    "than any filter.",
  categories:
    "Journal categories to restrict to. Valid values come from corpus_context (MCP) or " +
    "GET /corpus/guide (REST) — guessing them silently returns nothing.",
  journalName:
    "Journal-name substring(s), case-insensitive. A single string may carry several " +
    "comma-separated substrings, OR-ed together; an array works too.",
  jel:
    "JEL codes or prefixes to require, e.g. [\"J31\"] or [\"J3\",\"C21\"]. Coverage caveat: only " +
    "~55% of papers carry JEL codes (43% of journal articles), so this filter also drops " +
    "papers whose codes are merely unknown — never use it to prove an absence.",
  keywords:
    "Literal substrings, matched with SQL LIKE (not tokenised, not stemmed). OR-ed by default; " +
    "match=\"all\" requires every one of them.",
  openalexBlock:
    "Results may carry an `openalex` block, matched by DOI and covering roughly half the " +
    "corpus: `is_retracted`, `oa_url` (free full text) and `fwci` (field-weighted citation " +
    "impact). Its ABSENCE means the paper was not matched, never that its impact is low.",
} as const;

// What each API-key scope actually grants. Served by GET /admin/keys so the admin console
// renders authoritative text instead of its own copy drifting out of date.
export const SCOPE_DOCS: Record<Scope, string> = {
  rest: "The REST search endpoints and the web app (/search, /papers/*, /person/*, /chat).",
  mcp: "Connect to the MCP server and call the cheap, no-LLM tools it exposes for this key.",
  lit_search:
    "The lit_search pipeline in its default script-only mode: the server writes and runs the " +
    "search script and returns the papers, BibTeX, CSV and script. No review is written.",
  lit_search_synth:
    "Additionally lets this key ask the server to WRITE the literature review (synthesize=true). " +
    "This is the expensive stage and is off by default — only keys carrying this scope can " +
    "spend it. On MCP the request is refused without it; on the web app the search still runs " +
    "and returns results, without a written review.",
  admin: "Mint and revoke API keys, and reload the corpus snapshot. Hand out sparingly.",
};

interface FieldDoc {
  name: string;
  type: string;
  required?: boolean;
  doc: string;
}

interface EndpointDoc {
  method: string;
  path: string;
  scope: Scope | null;
  summary: string;
  fields: FieldDoc[];
}

const VERIFY_ENTRY_FIELDS: FieldDoc[] = [
  { name: "cite_key", type: "string?", doc: FIELD_DOCS.citeKey },
  { name: "handle", type: "string?", doc: FIELD_DOCS.handle },
  { name: "author_lastnames", type: "string?", doc: FIELD_DOCS.authorLastnames },
  { name: "year", type: "integer?", doc: FIELD_DOCS.entryYear },
  { name: "title", type: "string?", doc: FIELD_DOCS.entryTitle },
  { name: "journal", type: "string?", doc: FIELD_DOCS.entryJournal },
];

const ENDPOINTS: EndpointDoc[] = [
  {
    method: "POST",
    path: "/papers/verify",
    scope: "rest",
    summary:
      "Batch-verify bibliography entries against the corpus using three-tier matching: handle " +
      "lookup, then exact year + first author + title keyword, then year±1 + author + first two " +
      "title words. Per entry returns status (handle_match | fuzzy_match | loose_match | " +
      "not_found), the matched paper, citation stats, and year/journal mismatch flags. " +
      "Give as much of each entry as you have — more fields only ever help.",
    fields: [
      {
        name: "entries",
        type: "array of objects (1-200)",
        required: true,
        doc: `Bibliography entries. Each object takes: ${VERIFY_ENTRY_FIELDS.map((f) => `${f.name} (${f.type})`).join(", ")}. ${FIELD_DOCS.openalexBlock}`,
      },
      ...VERIFY_ENTRY_FIELDS.map((f) => ({ ...f, name: `entries[].${f.name}` })),
    ],
  },
  {
    method: "POST",
    path: "/papers/keyword",
    scope: "rest",
    summary:
      "Literal LIKE keyword search over title (default), abstract or authors. Use it for " +
      "exhaustive term sweeps and known-phrase lookups where semantic search is too fuzzy.",
    fields: [
      { name: "keywords", type: "string[] (1-20)", required: true, doc: FIELD_DOCS.keywords },
      { name: "fields", type: '("title"|"abstract"|"authors")[]', doc: "Which columns to search. Default [\"title\"]." },
      { name: "match", type: '"any"|"all"', doc: "Whether one keyword suffices (default \"any\") or all must hit." },
      { name: "min_year", type: "integer?", doc: "Earliest publication year, inclusive." },
      { name: "max_year", type: "integer?", doc: "Latest publication year, inclusive." },
      { name: "categories", type: "string[]?", doc: FIELD_DOCS.categories },
      { name: "journal_name", type: "string|string[]?", doc: FIELD_DOCS.journalName },
      { name: "order_by", type: '"year"|"citations"', doc: "Sort order; \"citations\" surfaces established work." },
      { name: "limit", type: "integer (1-500)", doc: "Page size, default 50." },
      { name: "offset", type: "integer", doc: "Page offset; pair with the returned `total`." },
    ],
  },
  {
    method: "POST",
    path: "/search",
    scope: "rest",
    summary: "Semantic vector search over the corpus — the engine behind econpapers.eduard-bruell.de.",
    fields: [
      { name: "query", type: "string", required: true, doc: FIELD_DOCS.semanticQuery },
      { name: "max_k", type: "integer (1-100)", doc: "Maximum results, default 30." },
      { name: "min_year", type: "integer?", doc: "Earliest publication year, inclusive." },
      { name: "journal_filter", type: "string[]?", doc: FIELD_DOCS.categories },
      { name: "journal_name", type: "string?", doc: FIELD_DOCS.journalName },
      { name: "title_keyword", type: "string?", doc: "Substring the title must contain." },
      { name: "author_keyword", type: "string?", doc: "Substring the author list must contain." },
      { name: "jel", type: "string[]?", doc: FIELD_DOCS.jel },
    ],
  },
  {
    method: "POST",
    path: "/chat",
    scope: "rest",
    summary:
      "Start an agentic literature search. Returns a run id immediately; follow GET /chat/{id}/stream " +
      "(SSE) for events. The written review is opt-in — see the `synthesize` field.",
    fields: [
      { name: "brief", type: "string (15-2000)", required: true, doc: "Prose description of what to find, like a request to a research assistant." },
      {
        name: "synthesize",
        type: "boolean",
        doc:
          "Whether the server WRITES the review over the results. Defaults true on this endpoint " +
          "(it backs the web app) but requires a key with the 'lit_search_synth' scope; a key " +
          "without it still gets the full search and its results, and the response echoes " +
          "`synthesize: false` so you know no review is coming. On MCP lit_search the same flag " +
          "defaults to FALSE.",
      },
      { name: "skipClarify", type: "boolean", doc: "Never stop to ask a clarifying question (one-shot mode)." },
      { name: "refine", type: "boolean", doc: "Allow one results-aware refine pass after the first round." },
      { name: "categories", type: "string[]?", doc: FIELD_DOCS.categories },
      { name: "minYear", type: "integer?", doc: "Earliest publication year, inclusive." },
      { name: "mustInclude", type: "string[]?", doc: "Authors or handles to include if they exist in the corpus." },
    ],
  },
  {
    method: "POST",
    path: "/person/search",
    scope: "rest",
    summary: "Find registered economists whose published work overlaps a research area.",
    fields: [
      { name: "query", type: "string", required: true, doc: FIELD_DOCS.semanticQuery },
      { name: "max_k", type: "integer (1-100)", doc: "Maximum people, default 25." },
      { name: "scoring_mode", type: '"breadth"|"best_match"|"blended"', doc: "breadth (default) rewards many overlapping papers; best_match rewards one strong paper." },
      { name: "quality_weight", type: "number (0-1)", doc: "Tilt the ranking toward citation-heavy authors." },
      { name: "active_since", type: "integer?", doc: "Require the author's last publication year to be at least this." },
      { name: "min_citations", type: "integer?", doc: "Minimum total citations." },
    ],
  },
  {
    method: "GET",
    path: "/corpus/guide",
    scope: null,
    summary:
      "Free reference metadata: the valid category and journal filter values, corpus sizes, and " +
      "query-writing guidance. Call it before guessing a filter value.",
    fields: [],
  },
];

// GET /docs — the public, machine-readable API reference. Unauthenticated on purpose: a caller
// who cannot yet authenticate is exactly the one who needs to read it.
export const apiReference = () => ({
  service: "eddyspapers-api",
  corpus: "~483k RePEc/EconLit economics papers and ~88k registered authors.",
  auth: {
    header: "Authorization: Bearer <key>  (or x-api-key: <key>)",
    scopes: ALL_SCOPES.map((s) => ({ scope: s, grants: SCOPE_DOCS[s] })),
    note:
      "Server-side synthesis is OFF by default and requires the 'lit_search_synth' scope. Every " +
      "other capability is retrieval, which is cheap and does not spend model tokens on writing.",
  },
  mcp: {
    endpoint: "/mcp",
    scope: "mcp",
    tools: [...MCP_TOOL_NAMES, "lit_search", "fetch_search"],
    note:
      "The MCP tools mirror these REST endpoints and carry the same field conventions in their " +
      "own schemas. lit_search and fetch_search ride the 'lit_search' scope, not the per-key tool " +
      "allowlist. A large lit_search run is delivered as a handle (digest + search_id) rather than " +
      "inlined; fetch_search reads its parts, as do the agenticsearch://searches/{id} resources.",
  },
  conventions: FIELD_DOCS,
  endpoints: ENDPOINTS,
});
