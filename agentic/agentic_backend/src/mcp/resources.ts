import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCorpusDb } from "../db/singleton.js";
import { corpusGuide } from "../search/guide.js";
import { citedByOf, citesOf, paperOverview } from "../search/citations.js";

// MCP resources (01_design.md §7.6). Phase 2 ships the read-only reference surface:
// the corpus guide and the paper-level lookups that subsume the old get_versions /
// get_citations / get_handle_stats tools. The agenticsearch://searches/{id} run
// resources depend on lit_search output and land with it in Phase 3.

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
        "One paper's record plus precomputed citation stats (handle_stats) and version links — the " +
        "canonical lookup that replaces separate versions/stats tools.",
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
}
