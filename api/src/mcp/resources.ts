import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCorpusDb, getSearchDb } from "../db/singleton.js";
import { corpusGuide } from "../search/guide.js";
import { citedByOf, citesOf, paperOverview } from "../search/citations.js";
import { buildBundle } from "../agent/bundle.js";

// MCP resources (01_design.md §7.6). Phase 2 shipped the read-only reference surface:
// the corpus guide and the paper-level lookups that subsume the old get_versions /
// get_citations / get_handle_stats tools. Phase 3 adds the agenticsearch://searches/{id}
// run resources — follow-up reads of a completed lit_search, rebuilt from its stored
// events (the same bundle the tool returned) so a caller can fetch just the script, the
// .bib, the full paper records, or one section without re-holding the whole payload.

// RePEc handles carry colons ("RePEc:aea:aecrev:...") but no slashes, so the default
// {handle} template segment ([^/,]+) captures them raw. A client may still send them
// percent-encoded; decode defensively (a no-op on raw handles, which contain no '%').
const decodeHandle = (raw: string | string[]): string => {
  const v = Array.isArray(raw) ? (raw[0] ?? "") : raw;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const json = (uri: URL, data: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

const text = (uri: URL, mimeType: string, body: string) => ({
  contents: [{ uri: uri.href, mimeType, text: body }],
});

// Rebuild a stored run into the same bundle the lit_search tool returned. Returns null
// for an unknown id so the resource handlers can answer with a structured not-found
// instead of throwing (mirrors the paper resources returning a null paper).
async function loadRun(id: string) {
  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) return null;
  return { search, bundle: buildBundle(id, search.brief, search.events) };
}

// Note: the ?limit=N shown for these resources in 01_design.md §7.6 is NOT wired —
// the SDK's ResourceTemplate matcher rejects any URI carrying a query string the
// template doesn't declare, and its {?limit} form makes the param mandatory, which
// would break the common no-limit read. Resources return the default cap; callers
// wanting a different N use the search tools. §7.6 must drop ?limit=N to match (§10).

export function registerResources(server: McpServer): void {
  server.registerResource(
    "corpus-guide",
    "corpus://guide",
    {
      title: "Corpus guide",
      description:
        "Snapshot date, corpus sizes, journal categories with example journals (valid filter values), " +
        "and query-writing guidance. Mirrors the corpus_context tool.",
      mimeType: "application/json",
    },
    async (uri) => json(uri, await corpusGuide(await getCorpusDb())),
  );

  server.registerResource(
    "paper",
    new ResourceTemplate("agenticsearch://papers/{handle}", { list: undefined }),
    {
      title: "Paper overview",
      description:
        "One paper's record plus precomputed RePEc citation stats (handle_stats), version links, and " +
        "OpenAlex metrics (whole-literature cited-by, FWCI, percentiles, retraction, open-access link) " +
        "when available — the canonical lookup that replaces separate versions/stats tools.",
      mimeType: "application/json",
    },
    async (uri, variables) => json(uri, await paperOverview(await getCorpusDb(), decodeHandle(variables.handle))),
  );

  server.registerResource(
    "paper-cites",
    new ResourceTemplate("agenticsearch://papers/{handle}/cites", { list: undefined }),
    {
      title: "Papers referenced by this one",
      description: "Internal citations: papers in the corpus that this handle references.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const handle = decodeHandle(variables.handle);
      return json(uri, { handle, cites: await citesOf(await getCorpusDb(), handle) });
    },
  );

  server.registerResource(
    "paper-citedby",
    new ResourceTemplate("agenticsearch://papers/{handle}/citedby", { list: undefined }),
    {
      title: "Papers citing this one",
      description: "Internal citations: papers in the corpus that cite this handle.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const handle = decodeHandle(variables.handle);
      return json(uri, { handle, citedby: await citedByOf(await getCorpusDb(), handle) });
    },
  );

  // ── Completed lit_search runs (§7.6) — follow-up reads keyed by search_id ──────────
  const first = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? "") : v);

  server.registerResource(
    "search-overview",
    new ResourceTemplate("agenticsearch://searches/{id}", { list: undefined }),
    {
      title: "Search run overview",
      description:
        "A completed lit_search run: the brief, status, synthesis, and a per-section summary. Read the " +
        "/script, /bibtex, /papers, or /sections/{sid} sub-resources for the full artifacts.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const run = await loadRun(first(variables.id));
      if (!run) return json(uri, { error: "search not found" });
      const { search, bundle } = run;
      return json(uri, {
        id: search.id,
        brief: search.brief,
        status: search.status,
        synthesis_md: bundle.synthesis_md,
        n_papers: Object.keys(bundle.papers).length,
        n_persons: Object.keys(bundle.persons).length,
        sections: bundle.sections.map((s) => ({
          id: s.id,
          title: s.title,
          mode: s.mode,
          kind: s.kind ?? "papers",
          n_total: s.n_total,
          n_shown: s.n_shown,
        })),
      });
    },
  );

  server.registerResource(
    "search-script",
    new ResourceTemplate("agenticsearch://searches/{id}/script", { list: undefined }),
    { title: "Search R script", description: "The R script that produced this run.", mimeType: "text/plain" },
    async (uri, variables) => {
      const run = await loadRun(first(variables.id));
      return text(uri, "text/plain", run?.bundle.script ?? "");
    },
  );

  server.registerResource(
    "search-bibtex",
    new ResourceTemplate("agenticsearch://searches/{id}/bibtex", { list: undefined }),
    { title: "Search BibTeX", description: "The deduped .bib bundle for this run.", mimeType: "application/x-bibtex" },
    async (uri, variables) => {
      const run = await loadRun(first(variables.id));
      return text(uri, "application/x-bibtex", run?.bundle.bibtex ?? "");
    },
  );

  server.registerResource(
    "search-papers",
    new ResourceTemplate("agenticsearch://searches/{id}/papers", { list: undefined }),
    {
      title: "Search papers",
      description: "Full paper records for this run, plus the flat CSV.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const run = await loadRun(first(variables.id));
      if (!run) return json(uri, { error: "search not found" });
      return json(uri, { papers: run.bundle.papers, papers_csv: run.bundle.papers_csv });
    },
  );

  server.registerResource(
    "search-section",
    new ResourceTemplate("agenticsearch://searches/{id}/sections/{sid}", { list: undefined }),
    {
      title: "Search section",
      description: "One section's full row set from a completed run.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const run = await loadRun(first(variables.id));
      // The SDK does not decode path segments, so a percent-encoded section id (a client
      // may encode reserved chars) must be decoded before the exact-id match. decodeHandle
      // is a no-op on the raw ids we generate (sem-1, kw-1, …), which contain no '%'.
      const sid = decodeHandle(variables.sid);
      const section = run?.bundle.sections.find((s) => s.id === sid);
      if (!section) return json(uri, { error: "section not found" });
      return json(uri, { section });
    },
  );
}
