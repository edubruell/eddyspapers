import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Paper, Section, StreamEvent } from "../../src/agent/types.js";

// agenticsearch://searches/{id}[...] resources (01_design.md §7.6, Phase 3): follow-up
// reads of a completed lit_search run. Seeded directly through the searches store — no
// pipeline, no corpus, no Ollama — then read back through a real MCP Client.

const RUN_ID = "run_abc123";
const RUNNING_ID = "run_running";
const TRICKY_ID = "run_tricky";
const BRIEF = "Minimum wage employment effects across US state borders";

let seq = 0;
const ev = (e: Omit<StreamEvent, "seq">): StreamEvent => ({ ...e, seq: seq++ } as StreamEvent);

const paper: Paper = {
  handle: "repec:aea:aer:1",
  title: "Minimum Wage and Employment",
  authors: ["Dube, A.", "Lester, T."],
  year: 2010,
  journal: "American Economic Review",
  category: "Top 5 Journals",
  url: "https://x/1",
  abstract: "Border-discontinuity evidence.",
  bibtex: "@article{dube2010,}",
};

const section: Section = {
  id: "sem-1",
  title: "Semantic: minimum wage",
  mode: "semantic",
  n_total: 1,
  n_shown: 1,
  rows: [{ handle: paper.handle, rank: 1, similarity: 0.2 }],
};

let client: Client;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-searchres-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  delete process.env.AGENTIC_PASSWORD;

  const { getSearchDb } = await import("../../src/db/singleton.js");
  const db = await getSearchDb();
  const events: StreamEvent[] = [
    ev({ type: "strategy", strategy: "Semantic sweep of the minimum-wage literature." }),
    ev({ type: "script", delta: "handles <- c('repec:aea:aer:1')" }),
    ev({ type: "paper", paper }),
    ev({ type: "section", section }),
    ev({ type: "bibtex", entries: 1, bibtex: "@article{dube2010,}" }),
    ev({ type: "synthesis", delta: "## Review\nSmall disemployment effects." }),
    ev({ type: "done", ms_total: 100 }),
  ];
  await db.upsertSearch(RUN_ID, { brief: BRIEF, dbSnapshotDate: "2026-06-01" });
  await db.appendEvents(RUN_ID, events);
  await db.finalizeSearch(RUN_ID, "done", "## Review\nSmall disemployment effects.");

  // A run still in flight (status=running): upserted + partial events, never finalized.
  const runningEvents: StreamEvent[] = [
    ev({ type: "strategy", strategy: "Sweep, mid-flight." }),
    ev({ type: "script", delta: "handles <- character(0)" }),
  ];
  await db.upsertSearch(RUNNING_ID, { brief: "still running brief", dbSnapshotDate: "2026-06-01" });
  await db.appendEvents(RUNNING_ID, runningEvents);

  // A completed run whose section id and paper fields carry regex-special / CSV-hostile chars.
  const trickyPaper: Paper = {
    handle: "repec:x:a+b(c):1",
    title: 'Regex, "quotes" and\ncommas',
    authors: ["O'Neil, S."],
    year: 2015,
    journal: "Journal of Money, Credit and Banking",
    category: "Macro",
    url: "https://x/regex",
    abstract: null,
    bibtex: "@article{oneil2015,}",
  };
  const trickySection: Section = {
    id: "sec.a+b(c)*",
    title: "Tricky",
    mode: "keyword",
    n_total: 1,
    n_shown: 1,
    rows: [{ handle: trickyPaper.handle, rank: 1, similarity: 0.5 }],
  };
  const trickyEvents: StreamEvent[] = [
    ev({ type: "paper", paper: trickyPaper }),
    ev({ type: "section", section: trickySection }),
    ev({ type: "done", ms_total: 10 }),
  ];
  await db.upsertSearch(TRICKY_ID, { brief: "tricky chars brief", dbSnapshotDate: "2026-06-01" });
  await db.appendEvents(TRICKY_ID, trickyEvents);
  await db.finalizeSearch(TRICKY_ID, "done", "done.");

  const { buildMcpServer } = await import("../../src/mcp/server.js");
  const server = buildMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "searchres-test", version: "1.0.0" });
  await client.connect(clientT);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const jsonOf = (res: { contents: { text?: string }[] }) => JSON.parse(res.contents[0].text ?? "{}");

describe("search resource templates", () => {
  it("lists all five searches:// templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const t = resourceTemplates.map((r) => r.uriTemplate);
    expect(t).toContain("agenticsearch://searches/{id}");
    expect(t).toContain("agenticsearch://searches/{id}/script");
    expect(t).toContain("agenticsearch://searches/{id}/bibtex");
    expect(t).toContain("agenticsearch://searches/{id}/papers");
    expect(t).toContain("agenticsearch://searches/{id}/sections/{sid}");
  });
});

describe("search overview", () => {
  it("returns the brief, status, synthesis, and a per-section summary", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}` });
    const o = jsonOf(res);
    expect(o.id).toBe(RUN_ID);
    expect(o.brief).toBe(BRIEF);
    expect(o.status).toBe("done");
    expect(o.synthesis_md).toMatch(/disemployment/);
    expect(o.n_papers).toBe(1);
    expect(o.n_persons).toBe(0);
    expect(o.sections).toEqual([
      { id: "sem-1", title: "Semantic: minimum wage", mode: "semantic", kind: "papers", n_total: 1, n_shown: 1 },
    ]);
  });

  it("returns a structured not-found for an unknown id (does not throw)", async () => {
    const res = await client.readResource({ uri: "agenticsearch://searches/nope" });
    expect(jsonOf(res).error).toMatch(/not found/i);
  });
});

describe("search sub-resources", () => {
  it("serves the R script as text", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}/script` });
    expect(res.contents[0].mimeType).toBe("text/plain");
    expect(res.contents[0].text).toContain("handles <- c(");
  });

  it("serves the BibTeX bundle", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}/bibtex` });
    expect(res.contents[0].mimeType).toBe("application/x-bibtex");
    expect(res.contents[0].text).toContain("@article{dube2010,}");
  });

  it("serves the full paper records plus the flat CSV", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}/papers` });
    const p = jsonOf(res);
    expect(p.papers).toHaveProperty(paper.handle);
    expect(p.papers_csv.split("\n")[0]).toMatch(/^handle,title,authors/);
    expect(p.papers_csv).toContain("0.2");
  });

  it("serves one section by id", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}/sections/sem-1` });
    expect(jsonOf(res).section.id).toBe("sem-1");
  });

  it("returns a structured not-found for an unknown section id", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUN_ID}/sections/zzz` });
    expect(jsonOf(res).error).toMatch(/section not found/i);
  });
});

// ── Additional edge cases (Phase 3 test extension) ─────────────────────────────────────
describe("search overview — non-terminal run", () => {
  it("serves the overview of a still-running run with its partial artifacts and running status", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUNNING_ID}` });
    const o = jsonOf(res);
    expect(o.id).toBe(RUNNING_ID);
    expect(o.status).toBe("running");
    expect(o.synthesis_md).toBe(""); // no synthesis emitted yet
    expect(o.n_papers).toBe(0);
    expect(o.sections).toEqual([]);
  });

  it("serves the (empty) script of a running run without erroring", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${RUNNING_ID}/script` });
    expect(res.contents[0].mimeType).toBe("text/plain");
    expect(res.contents[0].text).toContain("handles <- character(0)");
  });
});

describe("search section — regex-special section id", () => {
  it("matches a section id with dots/parens/star exactly via === (not as a regex)", async () => {
    // These metacharacters ('.', '(', ')', '*') survive a URI path segment untouched (no %),
    // so the raw variable already equals the stored id and the === lookup matches.
    const res = await client.readResource({
      uri: `agenticsearch://searches/${TRICKY_ID}/sections/sec.a+b(c)*`,
    });
    const o = jsonOf(res);
    // NOTE: a raw '+' in a URI path is legal and passes through as-is here.
    expect(o.error).toBeUndefined();
    expect(o.section.id).toBe("sec.a+b(c)*");
  });

  it("does not let a regex-special query act as a pattern (no false positive match)", async () => {
    // "sec.a.b.c." as a regex would match "sec.a+b(c)*"; as a literal it must NOT.
    const res = await client.readResource({
      uri: `agenticsearch://searches/${TRICKY_ID}/sections/${encodeURIComponent("sec.a.b.c.")}`,
    });
    expect(jsonOf(res).error).toMatch(/section not found/i);
  });

  // The section handler decodes {sid} (decodeHandle) before the exact-id match, mirroring the
  // paper resource — so a client that percent-encodes reserved chars ('+' → '%2B') still resolves
  // the section. The SDK template itself does NOT decode path segments, hence the explicit decode.
  it("resolves a percent-encoded section id", async () => {
    const res = await client.readResource({
      uri: `agenticsearch://searches/${TRICKY_ID}/sections/${encodeURIComponent("sec.a+b(c)*")}`,
    });
    expect(jsonOf(res).error).toBeUndefined();
    expect(jsonOf(res).section.id).toBe("sec.a+b(c)*");
  });
});

describe("search papers — CSV escaping through the resource", () => {
  it("round-trips a CSV with quotes/commas/newlines correctly escaped", async () => {
    const res = await client.readResource({ uri: `agenticsearch://searches/${TRICKY_ID}/papers` });
    const p = jsonOf(res);
    expect(p.papers).toHaveProperty("repec:x:a+b(c):1");
    const csv = p.papers_csv as string;
    expect(csv.split("\n")[0]).toMatch(/^handle,title,authors/);
    // title has quotes, a comma, and a newline → RFC4180 quoted + doubled quotes
    expect(csv).toContain('"Regex, ""quotes"" and\ncommas"');
    // handle contains a comma-free but paren/plus string → stays unquoted
    expect(csv).toContain("repec:x:a+b(c):1");
  });
});
