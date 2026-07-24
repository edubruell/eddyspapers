import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FIXTURE_PATH, requireFixture, loadQueryVec } from "../search/helpers.js";

// Phase 2 edge-case coverage (PLAN.md §12.4 hot spots: malformed MCP payloads,
// schema round-trips, resource-URI parsing). Extends tests/mcp/server.test.ts.
// Ollama-backed tools (find_papers / find_people) are exercised at the
// registration / schema / validation level only — never live.

let client: Client;
let sampleHandle: string;

const textOf = (res: { content?: unknown }): string => {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  return content.find((b) => b.type === "text")?.text ?? "";
};

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;
  sampleHandle = loadQueryVec().handle;

  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "edgecase-test", version: "1.0.0" });
  await client.connect(clientT);
});

// --- Schema round-trips: the advertised inputSchema is the tool's contract. -------

describe("tool inputSchema round-trips", () => {
  it("exposes the documented properties for every tool", async () => {
    const { tools } = await client.listTools();
    const props = (name: string) =>
      Object.keys(tools.find((t) => t.name === name)?.inputSchema?.properties ?? {}).sort();

    expect(props("find_papers")).toEqual(
      ["author_keyword", "categories", "jel", "journal_name", "max_k", "min_year", "query", "title_keyword"].sort(),
    );
    expect(props("keyword_search")).toEqual(
      [
        "categories",
        "fields",
        "jel",
        "journal_name",
        "keywords",
        "limit",
        "match",
        "max_year",
        "min_year",
        "offset",
        "order_by",
      ].sort(),
    );
    expect(props("find_people")).toEqual(
      [
        "active_since",
        "categories",
        "max_k",
        "min_citations",
        "min_year",
        "query",
        "quality_weight",
        "scoring_mode",
      ].sort(),
    );
    expect(props("verify_references")).toEqual(["entries"]);
  });

  it("marks query as required on the Ollama-backed search tools", async () => {
    const { tools } = await client.listTools();
    const required = (name: string) =>
      (tools.find((t) => t.name === name)?.inputSchema as { required?: string[] })?.required ?? [];
    expect(required("find_papers")).toContain("query");
    expect(required("find_people")).toContain("query");
    expect(required("keyword_search")).toContain("keywords");
    expect(required("verify_references")).toContain("entries");
  });

  it("corpus_context takes no arguments", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "corpus_context")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema?.properties ?? {})).toHaveLength(0);
    expect(schema?.required ?? []).toHaveLength(0);
  });
});

// --- Malformed payloads surface as isError results, not thrown promises. ----------

describe("malformed tool input → isError", () => {
  it("find_papers with missing query is a validation error", async () => {
    const res = await call("find_papers", { max_k: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/query/i);
  });

  it("find_papers with wrong-typed query is a validation error", async () => {
    const res = await call("find_papers", { query: 123 });
    expect(res.isError).toBe(true);
  });

  it("verify_references with an empty entries array is a validation error", async () => {
    const res = await call("verify_references", { entries: [] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/at least 1|validation/i);
  });

  it("verify_references over the 200-entry cap is a validation error", async () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({ title: `paper ${i}` }));
    const res = await call("verify_references", { entries });
    expect(res.isError).toBe(true);
  });

  it("keyword_search over the 500-limit cap is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], limit: 999 });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with a negative offset is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], offset: -1 });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with an unknown field enum is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], fields: ["fulltext"] });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with an unknown order_by enum is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], order_by: "relevance" });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with whitespace-only keywords (trimmed to empty) is a validation error", async () => {
    // z.string().trim().min(1) rejects a whitespace-only entry at the schema layer.
    const res = await call("keyword_search", { keywords: ["   "] });
    expect(res.isError).toBe(true);
  });

  it("find_papers with a 3-digit jel code is a validation error", async () => {
    const res = await call("find_papers", {
      query: "prose query about minimum wage employment effects",
      jel: ["J310"],
    });
    expect(res.isError).toBe(true);
  });

  it("find_papers with jel as a bare string (not array) is a validation error", async () => {
    const res = await call("find_papers", {
      query: "prose query about minimum wage employment effects",
      jel: "J31",
    });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with a LIKE-wildcard jel entry is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], jel: ["J3%"] });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with an empty-string jel entry is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], jel: [""] });
    expect(res.isError).toBe(true);
  });

  it("keyword_search with a two-letter jel entry is a validation error", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], jel: ["JJ3"] });
    expect(res.isError).toBe(true);
  });

  it("calling an unregistered tool is reported as an isError result", async () => {
    // In SDK 1.29.0 an unknown tool name resolves to a CallToolResult with
    // isError:true (-32602 not found), not a rejected promise.
    const res = await call("no_such_tool", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
  });
});

// --- SQL-only tools: structured/text parity + documented behaviour. ---------------

describe("keyword_search behaviour over MCP", () => {
  const rows = (res: { structuredContent?: unknown }) =>
    (res.structuredContent as { total: number; count: number; results: { Handle: string }[] });

  it("match='all' is narrower than match='any' and its rows are a subset", async () => {
    const kws = ["minimum", "wage"];
    const anyRes = rows(await call("keyword_search", { keywords: kws, match: "any", limit: 500 }));
    const allRes = rows(await call("keyword_search", { keywords: kws, match: "all", limit: 500 }));
    // AND ⊆ OR always holds on totals.
    expect(allRes.total).toBeLessThanOrEqual(anyRes.total);
    // Row-level subset is only sound when both pages are complete (total ≤ limit),
    // otherwise pagination truncation invalidates the set comparison.
    if (anyRes.total <= 500 && allRes.total <= 500) {
      const anyHandles = new Set(anyRes.results.map((r) => r.Handle));
      for (const r of allRes.results) expect(anyHandles.has(r.Handle)).toBe(true);
    }
  });

  it("a valid jel filter narrows results and accepts lowercase codes", async () => {
    const base = rows(await call("keyword_search", { keywords: ["minimum wage"], limit: 500 }));
    const withJel = rows(
      await call("keyword_search", { keywords: ["minimum wage"], jel: ["j3"], limit: 500 }),
    );
    expect(withJel.total).toBeGreaterThan(0);
    expect(withJel.total).toBeLessThan(base.total);
  });

  it("order_by='citations' returns without error and joins handle_stats", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], order_by: "citations", limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(rows(res).results.length).toBeGreaterThan(0);
  });

  it("offset pagination returns disjoint pages", async () => {
    const page1 = rows(await call("keyword_search", { keywords: ["wage"], limit: 3, offset: 0 }));
    const page2 = rows(await call("keyword_search", { keywords: ["wage"], limit: 3, offset: 3 }));
    if (page1.total > 3) {
      const h1 = new Set(page1.results.map((r) => r.Handle));
      for (const r of page2.results) expect(h1.has(r.Handle)).toBe(false);
    }
  });

  it("text block and structuredContent parse to the same object (SQL-only tool)", async () => {
    const res = await call("keyword_search", { keywords: ["wage"], limit: 4 });
    expect(JSON.parse(textOf(res))).toEqual(res.structuredContent);
  });
});

describe("verify_references summary parity", () => {
  it("summary counts sum to results.length", async () => {
    const res = await call("verify_references", {
      entries: [
        { author_lastnames: "Dube; Lester; Reich", year: 2010, title: "Minimum Wage Effects Across State Borders" },
        { author_lastnames: "Zzyzx", year: 1999, title: "Fictional Nonexistent Paper" },
        { author_lastnames: "Nobody", year: 1900, title: "Another Fiction That Does Not Exist" },
      ],
    });
    const sc = res.structuredContent as {
      count: number;
      summary: Record<string, number>;
      results: unknown[];
    };
    const summed = Object.values(sc.summary).reduce((a, b) => a + b, 0);
    expect(summed).toBe(sc.results.length);
    expect(sc.count).toBe(sc.results.length);
    expect(JSON.parse(textOf(res))).toEqual(sc);
  });
});

describe("corpus_context parity", () => {
  it("text block equals structuredContent and takes no args", async () => {
    const res = await call("corpus_context", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual(res.structuredContent);
  });
});

// --- Resource-URI parsing. --------------------------------------------------------

describe("resource-URI parsing", () => {
  it("a colon-bearing handle round-trips through the base template", async () => {
    expect(sampleHandle).toContain(":");
    const res = await client.readResource({ uri: `agenticsearch://papers/${sampleHandle}` });
    const overview = JSON.parse(res.contents[0].text as string) as { paper: { Handle: string } | null };
    expect(overview.paper?.Handle.toLowerCase()).toBe(sampleHandle.toLowerCase());
    // The echoed contents URI carries the handle back verbatim (percent-encoding aside).
    expect(decodeURIComponent(res.contents[0].uri)).toContain(sampleHandle);
  });

  it("a nonexistent handle returns an overview with paper:null (no crash)", async () => {
    const res = await client.readResource({
      uri: "agenticsearch://papers/RePEc:zzz:nosuch:v:1:y:1900",
    });
    const overview = JSON.parse(res.contents[0].text as string) as {
      paper: unknown;
      stats: unknown;
      versions: unknown[];
    };
    expect(overview.paper).toBeNull();
    expect(overview.stats).toBeNull();
    expect(overview.versions).toEqual([]);
  });

  it("a /cites suffix does not collide with the bare-handle template", async () => {
    // The base papers/{handle} template must not swallow the /cites segment: the
    // cites read returns a {cites:[...]} shape, the base read a paper overview.
    const cites = await client.readResource({ uri: `agenticsearch://papers/${sampleHandle}/cites` });
    const parsed = JSON.parse(cites.contents[0].text as string) as {
      handle: string;
      cites?: unknown[];
      paper?: unknown;
    };
    expect(parsed).toHaveProperty("cites");
    expect(parsed).not.toHaveProperty("paper");
    expect(parsed.handle.toLowerCase()).toBe(sampleHandle.toLowerCase());
  });

  it("citedby for a nonexistent handle returns an empty list, not a crash", async () => {
    const res = await client.readResource({
      uri: "agenticsearch://papers/RePEc:zzz:nosuch:v:1:y:1900/citedby",
    });
    const parsed = JSON.parse(res.contents[0].text as string) as { citedby: unknown[] };
    expect(parsed.citedby).toEqual([]);
  });

  it("reading an unregistered URI scheme errors", async () => {
    await expect(client.readResource({ uri: "bogus://not/a/resource" })).rejects.toThrow();
  });
});

// --- Prompts. ---------------------------------------------------------------------

describe("prompts round-trips", () => {
  it("find_referees without a journal omits the journal clause", async () => {
    const res = await client.getPrompt({ name: "find_referees", arguments: { topic: "monopsony" } });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/monopsony/);
    expect(text).toMatch(/find_people/);
    expect(text).not.toMatch(/Prefer authors who publish in/);
  });

  it("find_referees with a journal includes the journal clause", async () => {
    const res = await client.getPrompt({
      name: "find_referees",
      arguments: { topic: "monopsony", journal: "Econometrica" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/Prefer authors who publish in Econometrica/);
  });

  it("journal_scan without keywords omits the keywords array", async () => {
    const res = await client.getPrompt({
      name: "journal_scan",
      arguments: { journal: "American Economic Review" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/American Economic Review/);
    expect(text).not.toMatch(/keywords=\[/);
  });

  it("journal_scan trims whitespace around split keywords", async () => {
    const res = await client.getPrompt({
      name: "journal_scan",
      arguments: { journal: "AER", keywords: "  wage ,  employment  ,minimum wage" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/keywords=\["wage", "employment", "minimum wage"\]/);
  });

  it("lit_review with a purpose includes the purpose clause", async () => {
    const res = await client.getPrompt({
      name: "lit_review",
      arguments: { topic: "monopsony", purpose: "grant" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/Intended purpose: grant/);
  });

  it("getPrompt for an unknown prompt name errors", async () => {
    await expect(client.getPrompt({ name: "no_such_prompt", arguments: {} })).rejects.toThrow();
  });
});
