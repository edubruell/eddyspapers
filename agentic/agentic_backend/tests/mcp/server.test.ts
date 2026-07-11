import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FIXTURE_PATH, requireFixture, loadQueryVec } from "../search/helpers.js";

// MCP smoke tests (PLAN.md §12.1): drive a real Client against the assembled server
// over a linked in-memory transport pair — the same tools/resources/prompts the
// hosted HTTP and stdio faces expose. Ollama-backed tools (find_papers/find_people)
// are asserted at the registration level only; the SQL-only tools run end-to-end
// against the fixture so no embedding service is needed.

let client: Client;
let sampleHandle: string;

const textOf = (res: { content?: unknown }): string => {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const block = content.find((b) => b.type === "text");
  return block?.text ?? "";
};

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;
  sampleHandle = loadQueryVec().handle;

  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(clientT);
});

describe("MCP initialize", () => {
  it("advertises server instructions and capabilities", () => {
    expect(client.getInstructions()).toMatch(/RePEc/i);
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
  });
});

describe("tools/list", () => {
  it("lists all six tools with input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["corpus_context", "find_papers", "find_people", "keyword_search", "lit_search", "verify_references"].sort(),
    );
    const findPapers = tools.find((t) => t.name === "find_papers");
    expect(findPapers?.inputSchema?.properties).toHaveProperty("query");
    expect(findPapers?.description).toMatch(/prose/i);
  });
});

describe("tools/call — SQL-only tools run against the fixture", () => {
  it("keyword_search returns totals and rows", async () => {
    const res = await client.callTool({
      name: "keyword_search",
      arguments: { keywords: ["minimum wage"], limit: 3 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { total: number; results: unknown[] };
    expect(sc.total).toBeGreaterThan(0);
    expect(sc.results.length).toBe(3);
    // Text block must be parseable JSON mirroring structuredContent.
    expect(JSON.parse(textOf(res)).total).toBe(sc.total);
  });

  it("verify_references reports per-entry status and a summary", async () => {
    const res = await client.callTool({
      name: "verify_references",
      arguments: {
        entries: [
          { author_lastnames: "Dube; Lester; Reich", year: 2010, title: "Minimum Wage Effects Across State Borders" },
          { author_lastnames: "Zzyzx", year: 1999, title: "Fictional Nonexistent Paper" },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { results: { status: string }[]; summary: Record<string, number> };
    expect(sc.results.map((r) => r.status)).toEqual(["fuzzy_match", "not_found"]);
    expect(sc.summary.not_found).toBe(1);
  });

  it("corpus_context returns the guide", async () => {
    const res = await client.callTool({ name: "corpus_context", arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { total_articles: number; categories: unknown[] };
    expect(sc.total_articles).toBeGreaterThan(0);
    expect(sc.categories.length).toBe(7);
  });

  it("reports malformed tool input as an isError result (empty keyword list)", async () => {
    const res = await client.callTool({ name: "keyword_search", arguments: { keywords: [] } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/validation|at least 1/i);
  });
});

describe("resources", () => {
  it("lists the static corpus guide resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("corpus://guide");
  });

  it("lists the paper-level resource templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain("agenticsearch://papers/{handle}");
    expect(templates).toContain("agenticsearch://papers/{handle}/cites");
    expect(templates).toContain("agenticsearch://papers/{handle}/citedby");
  });

  it("reads corpus://guide", async () => {
    const res = await client.readResource({ uri: "corpus://guide" });
    const guide = JSON.parse(res.contents[0].text as string) as { total_articles: number };
    expect(guide.total_articles).toBeGreaterThan(0);
  });

  it("reads a paper overview by handle (colons in handle survive templating)", async () => {
    const res = await client.readResource({ uri: `agenticsearch://papers/${sampleHandle}` });
    const overview = JSON.parse(res.contents[0].text as string) as {
      paper: { Handle: string } | null;
      versions: unknown[];
    };
    expect(overview.paper?.Handle.toLowerCase()).toBe(sampleHandle.toLowerCase());
    expect(Array.isArray(overview.versions)).toBe(true);
  });

  it("reads cites and citedby for a handle", async () => {
    const cites = await client.readResource({ uri: `agenticsearch://papers/${sampleHandle}/cites` });
    const citedby = await client.readResource({ uri: `agenticsearch://papers/${sampleHandle}/citedby` });
    expect(JSON.parse(cites.contents[0].text as string)).toHaveProperty("cites");
    expect(JSON.parse(citedby.contents[0].text as string)).toHaveProperty("citedby");
  });

  it("does not match a cites URI carrying a query string (?limit is not wired — §7.6/§10)", async () => {
    // The SDK ResourceTemplate matcher rejects a query string the template doesn't
    // declare, so ?limit=N reads as an unknown resource rather than silently ignoring
    // the param. Documents why the limit passthrough is intentionally absent.
    await expect(
      client.readResource({ uri: `agenticsearch://papers/${sampleHandle}/cites?limit=1` }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("prompts", () => {
  it("lists the three named prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      ["find_referees", "journal_scan", "lit_review"].sort(),
    );
  });

  it("expands lit_review into a brief mentioning the topic and the tools", async () => {
    const res = await client.getPrompt({
      name: "lit_review",
      arguments: { topic: "monopsony in labor markets" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/monopsony in labor markets/);
    expect(text).toMatch(/lit_search/);
  });

  it("journal_scan turns comma-separated keywords into a keyword array", async () => {
    const res = await client.getPrompt({
      name: "journal_scan",
      arguments: { journal: "American Economic Review", keywords: "wage, employment" },
    });
    const text = (res.messages[0].content as { text: string }).text;
    expect(text).toMatch(/"wage", "employment"/);
    expect(text).toMatch(/American Economic Review/);
  });
});
