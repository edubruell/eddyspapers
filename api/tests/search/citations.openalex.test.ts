import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CorpusDb } from "../../src/db/corpus.js";
import { paperOverview } from "../../src/search/citations.js";

// M9 Workstream B: the agenticsearch://papers/{handle} bundle (paperOverview) carries an
// `openalex` key alongside paper/stats/versions — the fuller OpenAlexStats shape (percentiles,
// top-1/10%) used by the paper detail view. Null on pre-Track-B snapshots or unmatched works.

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
      'A','http://x/1','10.1/x','@a{}','Effects of minimum wage.')`,
  );
  await conn.run("CREATE TABLE handle_stats (handle VARCHAR, total_citations INTEGER)");
  await conn.run("INSERT INTO handle_stats VALUES ('repec:aaa:bbb:1', 7)");
  await conn.run("CREATE TABLE version_links (source VARCHAR, target VARCHAR, type VARCHAR)");
  if (withOpenAlex) {
    await conn.run(`
      CREATE TABLE article_openalex (
        handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
        oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
        is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
        is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
        primary_topic VARCHAR, primary_field VARCHAR
      )`);
    // Mixed-case handle stored lowercase → proves the LOWER-join inside openalexStatsOf.
    await conn.run(
      `INSERT INTO article_openalex VALUES
       ('repec:aaa:bbb:1','https://openalex.org/W1','10.1/x',
        42, 1.75, 0.99, true, true, false, true, 'gold','https://oa/1',
        'Labour economics','Economics')`,
    );
  }
  return { db: wrap(conn), instance };
}

describe("paperOverview openalex bundle key — table present", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  beforeAll(async () => {
    ({ db, instance } = await makeCorpus(true));
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("bundles the fuller OpenAlexStats (percentiles + top-1) next to paper/stats/versions", async () => {
    const overview = await paperOverview(db, "RePEc:AAA:bbb:1");
    expect(overview.paper?.Handle).toBe("RePEc:AAA:bbb:1");
    expect(overview.openalex).not.toBeNull();
    expect(overview.openalex).toMatchObject({
      openalex_id: "https://openalex.org/W1",
      oa_cited_by_count: 42,
      fwci: 1.75,
      pctl_value: 0.99,
      is_top1: true,
      is_top10: true,
      is_retracted: false,
      oa_url: "https://oa/1",
    });
  });

  it("returns openalex: null for a handle with no matched work", async () => {
    const overview = await paperOverview(db, "RePEc:AAA:none:9");
    expect(overview.paper).toBeNull();
    expect(overview.openalex).toBeNull();
  });
});

describe("paperOverview openalex bundle key — sparse row", () => {
  it("preserves NULLs as null (no 0/false coercion) for an unscored matched work", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE articles (
        Handle VARCHAR, title VARCHAR, year INTEGER, authors VARCHAR, journal VARCHAR,
        category VARCHAR, url VARCHAR, doi VARCHAR, bib_tex VARCHAR, abstract VARCHAR
      )`);
    await conn.run(
      `INSERT INTO articles VALUES
       ('RePEc:AAA:bbb:2','A Recent Working Paper',2024,'Doe','WP','A',NULL,NULL,NULL,NULL)`,
    );
    await conn.run("CREATE TABLE handle_stats (handle VARCHAR, total_citations INTEGER)");
    await conn.run("CREATE TABLE version_links (source VARCHAR, target VARCHAR, type VARCHAR)");
    await conn.run(`
      CREATE TABLE article_openalex (
        handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
        oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
        is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
        is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
        primary_topic VARCHAR, primary_field VARCHAR
      )`);
    // A matched work OpenAlex has no metrics for yet: all scores NULL. optNum/optBool
    // must yield null, not Number(null)=0 / Boolean(null)=false.
    await conn.run(
      `INSERT INTO article_openalex VALUES
       ('repec:aaa:bbb:2','https://openalex.org/W2','10.1/y',
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    );
    const db = wrap(conn);
    const overview = await paperOverview(db, "RePEc:AAA:bbb:2");
    expect(overview.openalex).toMatchObject({
      openalex_id: "https://openalex.org/W2",
      oa_cited_by_count: null,
      fwci: null,
      is_retracted: null,
      is_oa: null,
    });
    db.close();
    instance.closeSync();
  });
});

describe("paperOverview openalex bundle key — table absent", () => {
  it("keeps the key present and null (no throw) on a pre-Track-B snapshot", async () => {
    const { db, instance } = await makeCorpus(false);
    const overview = await paperOverview(db, "RePEc:AAA:bbb:1");
    expect(overview.paper?.Handle).toBe("RePEc:AAA:bbb:1");
    expect(overview).toHaveProperty("openalex", null);
    db.close();
    instance.closeSync();
  });
});
