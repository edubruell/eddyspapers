import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CorpusDb } from "../../src/db/corpus.js";
import { keywordSearch, verifyReferences } from "../../src/search/papers.js";

// Workstream A coverage: the shared paper projection attaches an `openalex` block on
// snapshots that carry article_openalex, and omits the key entirely on snapshots that don't
// (so pre-Track-B responses stay byte-identical). Exercised through keywordSearch and
// verifyReferences — neither needs embeddings/vss, so a tiny hand-built corpus suffices.
// The LOWER-join on the mixed-case corpus Handle is the recurring hazard being pinned.

const wrap = (conn: Awaited<ReturnType<DuckDBInstance["connect"]>>): CorpusDb =>
  ({
    query: async (sql: string, params?: unknown[]) => {
      const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
      const names = reader.columnNames();
      const rows = await reader.getRows();
      return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
    },
    close: () => conn.disconnectSync(),
  }) as CorpusDb;

async function makeCorpus(withOpenAlex: boolean): Promise<{ db: CorpusDb; instance: DuckDBInstance }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(`
    CREATE TABLE articles (
      Handle VARCHAR, title VARCHAR, year INTEGER, authors VARCHAR, journal VARCHAR,
      category VARCHAR, url VARCHAR, doi VARCHAR, bib_tex VARCHAR, abstract VARCHAR
    )`);
  await conn.run(
    `INSERT INTO articles VALUES
     ('RePEc:AAA:bbb:1','Minimum Wage and Employment',2019,'Card; Krueger','AER',
      'A','http://x/1','10.1/x','@a{}','Effects of minimum wage.'),
     ('RePEc:AAA:bbb:2','Wage Gaps Revisited',2020,'Card','QJE',
      'A','http://x/2','10.1/y','@b{}','Persistent wage gaps.')`,
  );
  // verifyReferences enriches matched papers from handle_stats; an empty table is enough
  // here (this test pins the openalex block, not the RePEc-internal stats).
  await conn.run(
    "CREATE TABLE handle_stats (handle VARCHAR, citation_percentile DOUBLE, total_citations INTEGER, citations_per_year DOUBLE)",
  );
  if (withOpenAlex) {
    await conn.run(`
      CREATE TABLE article_openalex (
        handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
        oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
        is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
        is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
        primary_topic VARCHAR, primary_field VARCHAR
      )`);
    // Row 1: fully populated, MIXED-case handle stored lower to prove the LOWER-join.
    // Row 2: no article_openalex row at all → block must be null, not fabricated.
    await conn.run(
      `INSERT INTO article_openalex VALUES
       ('repec:aaa:bbb:1','https://openalex.org/W1','10.1/x',
        42, 1.75, 0.9, false, true, true, true, 'gold','https://oa/1',
        'Labour economics','Economics')`,
    );
  }
  return { db: wrap(conn), instance };
}

describe("PaperResult openalex block — table present", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  beforeAll(async () => {
    ({ db, instance } = await makeCorpus(true));
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("attaches a populated openalex block, joining on the mixed-case handle", async () => {
    const { results } = await keywordSearch(db, { keywords: ["minimum"], fields: ["title"] });
    expect(results).toHaveLength(1);
    expect(results[0].openalex).toEqual({
      openalex_id: "https://openalex.org/W1",
      oa_cited_by_count: 42,
      fwci: 1.75,
      is_retracted: true,
      is_oa: true,
      oa_url: "https://oa/1",
      oa_status: "gold",
      primary_topic: "Labour economics",
      primary_field: "Economics",
    });
  });

  it("sets openalex to null when the handle has no matched work", async () => {
    const { results } = await keywordSearch(db, { keywords: ["revisited"], fields: ["title"] });
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("openalex", null);
  });

  it("carries the block through verifyReferences' matched paper", async () => {
    const [entry] = await verifyReferences(db, [{ handle: "RePEc:AAA:bbb:1" }]);
    expect(entry.status).toBe("handle_match");
    expect(entry.paper?.openalex?.is_retracted).toBe(true);
    expect(entry.paper?.openalex?.oa_url).toBe("https://oa/1");
  });

  it("carries the block through a tier-2 (fuzzy) verifyReferences match", async () => {
    const [entry] = await verifyReferences(db, [
      { author_lastnames: "Card", year: 2019, title: "Minimum Wage and Employment" },
    ]);
    expect(entry.status).toBe("fuzzy_match");
    expect(entry.paper?.Handle).toBe("RePEc:AAA:bbb:1");
    expect(entry.paper?.openalex?.oa_cited_by_count).toBe(42);
  });

  it("composes the openalex join with the citations statsJoin (orderBy=citations)", async () => {
    const { total, results } = await keywordSearch(db, {
      keywords: ["wage"],
      fields: ["title"],
      orderBy: "citations",
    });
    // Two joins (handle_stats + article_openalex) must not fan the row set out:
    // total (count query, no joins) stays in step with the joined results rows.
    expect(total).toBe(2);
    expect(results).toHaveLength(2);
    const row1 = results.find((r) => r.Handle === "RePEc:AAA:bbb:1");
    expect(row1?.openalex?.openalex_id).toBe("https://openalex.org/W1");
    expect(results.find((r) => r.Handle === "RePEc:AAA:bbb:2")?.openalex).toBeNull();
  });
});

describe("PaperResult openalex block — table absent (pre-Track-B snapshot)", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  beforeAll(async () => {
    ({ db, instance } = await makeCorpus(false));
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("omits the openalex key entirely", async () => {
    const { results } = await keywordSearch(db, { keywords: ["minimum"], fields: ["title"] });
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("openalex");
  });
});
