import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCorpusDb } from "../db/singleton.js";
import { corpusGuide } from "../search/guide.js";
import { keywordSearch, semanticSearch, verifyReferences } from "../search/papers.js";
import { personSearch } from "../search/persons.js";
import { withRateLimit } from "./guard.js";
import type { KeyIdentity } from "../auth/keys.js";
import type { BibEntry, KeywordField } from "../search/types.js";

// The five cheap MCP tools (PLAN.md §C1). Each is a thin adapter over the same
// internal service function the REST routes call — no HTTP self-calls, no
// duplicated logic. Per-tool descriptions carry the doctrine a consuming model
// needs (§C3 layer 2); corpus_context (§C3 layer 3) supplies the filter values.
//
// Result convention: every tool returns the payload both as pretty-printed JSON in
// a text block (portable — every MCP client renders text) and as structuredContent
// (typed access for clients that support it). No outputSchema is declared, so the
// SDK passes structuredContent through unvalidated — deliberate: these shapes track
// the evolving PaperResult/PersonResult types, not a frozen wire contract.

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// Ollama-backed tools (find_papers, find_people) fail loudly and unhelpfully when
// the embedding service is unreachable; surface that as a tool-level error the
// calling agent can read, not a transport exception.
const guarded =
  (fn: () => Promise<CallToolResult>) =>
  async (): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

// Comma-separable substring filter, matching /papers/keyword and Plumber /search.
const splitJournalName = (s: string | undefined): string[] | null =>
  s == null ? null : s.split(",").map((v) => v.trim()).filter(Boolean);

// The canonical set of cheap MCP tools, and the single source of truth for the admin
// tool-allowlist UI (routes/admin.ts surfaces this as available_tools). lit_search is NOT
// here — it stays gated by its own 'lit_search' scope, not the per-key allowlist (M9 G).
export const MCP_TOOL_NAMES = [
  "find_papers",
  "keyword_search",
  "find_people",
  "verify_references",
  "corpus_context",
] as const;

export function registerTools(server: McpServer, key: KeyIdentity | null = null): void {
  // Per-key allowlist gate: a null key (dev/gate-disabled/stdio) or a null tools list means
  // every tool registers; otherwise a tool is registered only when named. A gated-out tool
  // simply never appears in the client's tool list — cleaner than registering-and-403'ing.
  const allowed = (name: (typeof MCP_TOOL_NAMES)[number]): boolean =>
    key == null || key.tools == null || key.tools.includes(name);

  if (allowed("find_papers"))
  server.registerTool(
    "find_papers",
    {
      title: "Semantic paper search",
      description:
        "Vector search over ~455k RePEc economics papers. Write the query as 3-6 sentences of " +
        "abstract-style prose describing the mechanism, method, and context studied — not topic " +
        "labels. Good: 'Causal effects of minimum wage increases on low-wage employment, using " +
        "border-discontinuity and synthetic-control designs across US states.' Bad: 'minimum wage " +
        "employment'. Use keyword_search instead for exhaustive term sweeps or known-title lookups. " +
        "Call corpus_context for valid category and journal filter values. Each result may carry an " +
        "`openalex` block (matched by DOI, ~half the corpus) with a retraction flag, open-access " +
        "link, and field-weighted citation impact — absence means unmatched, not low impact.",
      inputSchema: {
        query: z.string().min(1).describe("Abstract-style prose describing what to find"),
        max_k: z.number().int().min(1).max(100).optional().describe("Max results (default 30)"),
        min_year: z.number().int().optional(),
        categories: z.array(z.string()).optional().describe("Journal categories (see corpus_context)"),
        journal_name: z.string().optional().describe("Journal-name substring(s), comma-separable"),
        title_keyword: z.string().optional(),
        author_keyword: z.string().optional(),
        jel: z
          .array(z.string().regex(/^[A-Za-z]\d{0,2}$/))
          .optional()
          .describe(
            "JEL codes or prefixes to require (e.g. ['J31'] or ['J3','C21']). " +
              "Coverage caveat: only ~55% of papers carry JEL codes (43% of journal articles), " +
              "so this filter also drops papers whose codes are simply unknown.",
          ),
      },
    },
    async (a) =>
      withRateLimit(key, "find_papers", () =>
      guarded(async () => {
        const db = await getCorpusDb();
        const papers = await semanticSearch(db, {
          query: a.query,
          maxK: a.max_k ?? 30,
          minYear: a.min_year,
          journalFilter: a.categories,
          journalName: splitJournalName(a.journal_name),
          titleKeyword: a.title_keyword,
          authorKeyword: a.author_keyword,
          jel: a.jel,
        });
        return ok({ count: papers.length, papers });
      })()),
  );

  if (allowed("keyword_search"))
  server.registerTool(
    "keyword_search",
    {
      title: "Keyword paper search",
      description:
        "Literal LIKE-based keyword search over paper title (default), abstract, or authors. Use for " +
        "exhaustive term sweeps and known-phrase lookups where semantic search is too fuzzy. Keywords " +
        "are OR-ed by default (match='any'); set match='all' to require every keyword. Combine with " +
        "category/year filters to keep result sets reviewable; order_by='citations' surfaces " +
        "established work. Returns a total count for pagination.",
      inputSchema: {
        keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
        fields: z.array(z.enum(["title", "abstract", "authors"])).min(1).optional(),
        match: z.enum(["any", "all"]).optional(),
        min_year: z.number().int().optional(),
        max_year: z.number().int().optional(),
        categories: z.array(z.string()).optional(),
        journal_name: z.string().optional().describe("Journal-name substring(s), comma-separable"),
        jel: z
          .array(z.string().regex(/^[A-Za-z]\d{0,2}$/))
          .optional()
          .describe("JEL codes or prefixes to require; ~55% coverage, absence means unknown"),
        order_by: z.enum(["year", "citations"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) =>
      withRateLimit(key, "keyword_search", () =>
      guarded(async () => {
        const db = await getCorpusDb();
        const result = await keywordSearch(db, {
          keywords: a.keywords,
          fields: a.fields as KeywordField[] | undefined,
          match: a.match,
          minYear: a.min_year,
          maxYear: a.max_year,
          categories: a.categories,
          journalName: splitJournalName(a.journal_name),
          jel: a.jel,
          orderBy: a.order_by,
          limit: a.limit,
          offset: a.offset,
        });
        return ok({ total: result.total, count: result.results.length, results: result.results });
      })()),
  );

  if (allowed("find_people"))
  server.registerTool(
    "find_people",
    {
      title: "Find economists by topic",
      description:
        "Find registered economists whose work overlaps a topic, via two-stage retrieval: a hidden " +
        "paper-level semantic search rolled up to authors (matched papers returned as evidence). " +
        "Write the query as abstract-style prose like find_papers. scoring_mode: 'breadth' (default, " +
        "rewards many overlapping papers), 'best_match' (rewards one strong paper), 'blended'. " +
        "quality_weight (0-1) tilts toward citation-heavy authors. Filter with active_since (last " +
        "publication year) and min_citations.",
      inputSchema: {
        query: z.string().min(1).describe("Abstract-style prose describing the research area"),
        max_k: z.number().int().min(1).max(100).optional().describe("Max people (default 25)"),
        scoring_mode: z.enum(["breadth", "best_match", "blended"]).optional(),
        quality_weight: z.number().min(0).max(1).optional(),
        min_year: z.number().int().optional().describe("Only count papers from this year onward"),
        categories: z.array(z.string()).optional(),
        active_since: z.number().int().optional().describe("Author's last publication year >= this"),
        min_citations: z.number().int().optional(),
      },
    },
    async (a) =>
      withRateLimit(key, "find_people", () =>
      guarded(async () => {
        const db = await getCorpusDb();
        const people = await personSearch(db, {
          query: a.query,
          maxK: a.max_k,
          scoringMode: a.scoring_mode,
          qualityWeight: a.quality_weight,
          minYear: a.min_year,
          journalFilter: a.categories,
          activeSince: a.active_since,
          minCitations: a.min_citations,
        });
        return ok({ count: people.length, people });
      })()),
  );

  if (allowed("verify_references"))
  server.registerTool(
    "verify_references",
    {
      title: "Verify a bibliography",
      description:
        "Batch-verify bibliography entries against the corpus using three-tier matching: handle " +
        "lookup, then exact year + first author + title keyword, then year±1 + author + first two " +
        "title words. Per entry returns a match status (handle_match | fuzzy_match | loose_match | " +
        "not_found), the matched paper, citation stats, and any year/journal mismatches. The matched " +
        "paper carries an `openalex` block when available (matched by DOI, ~half the corpus): check " +
        "`openalex.is_retracted` to flag retracted citations, `openalex.oa_url` for a free full text, " +
        "and `openalex.fwci` for field-normalised impact. Give as much of handle, author_lastnames " +
        "(semicolon-separated), year, title, journal as you have.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              cite_key: z.string().nullish(),
              handle: z.string().nullish(),
              author_lastnames: z.string().nullish(),
              year: z.number().int().nullish(),
              title: z.string().nullish(),
              journal: z.string().nullish(),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async (a) =>
      withRateLimit(key, "verify_references", () =>
      guarded(async () => {
        const db = await getCorpusDb();
        const results = await verifyReferences(db, a.entries as BibEntry[]);
        const summary = results.reduce<Record<string, number>>((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {});
        return ok({ count: results.length, summary, results });
      })()),
  );

  if (allowed("corpus_context"))
  server.registerTool(
    "corpus_context",
    {
      title: "Corpus guide",
      description:
        "Reference metadata for using this corpus well: snapshot date, article and author counts, the " +
        "journal categories with example journals (the valid filter values for the search tools), the " +
        "default category mix, and the semantic-query-writing doctrine. Free and cached — call it " +
        "before guessing category or journal filter values.",
      inputSchema: {},
    },
    async () =>
      withRateLimit(key, "corpus_context", () =>
      guarded(async () => {
        const db = await getCorpusDb();
        return ok({ ...(await corpusGuide(db)) });
      })()),
  );
}
