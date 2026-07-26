import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CorpusDb } from "../../src/db/corpus.js";
import { personPapers } from "../../src/search/personProfile.js";

// M9 Workstream E: a person's in-corpus papers carry the lean `openalex` block (FWCI, OA link,
// retraction) when the snapshot has article_openalex, and omit the key on pre-Track-B corpora.
// Exercised directly against a hand-built corpus (person_works + articles + handle_stats + OA).

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
      category VARCHAR, url VARCHAR, doi VARCHAR, bib_tex VARCHAR, abstract VARCHAR, is_series BOOLEAN
    )`);
  await conn.run(
    `INSERT INTO articles VALUES
     ('RePEc:AAA:bbb:1','Matched Paper',2019,'Card','AER','A','http://x/1','10.1/x','@a{}','abs',false),
     ('RePEc:AAA:bbb:2','Unmatched Paper',2020,'Card','QJE','A','http://x/2','10.1/y','@b{}','abs',false)`,
  );
  await conn.run("CREATE TABLE person_works (short_id VARCHAR, work_handle VARCHAR, work_type VARCHAR)");
  await conn.run(
    `INSERT INTO person_works VALUES
     ('pabc','repec:aaa:bbb:1','article'), ('pabc','repec:aaa:bbb:2','article')`,
  );
  await conn.run("CREATE TABLE handle_stats (handle VARCHAR, total_citations INTEGER)");
  await conn.run("INSERT INTO handle_stats VALUES ('repec:aaa:bbb:1', 12), ('repec:aaa:bbb:2', 3)");
  if (withOpenAlex) {
    await conn.run(`
      CREATE TABLE article_openalex (
        handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
        oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
        is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
        is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
        primary_topic VARCHAR, primary_field VARCHAR
      )`);
    // Only bbb:1 has a matched work; bbb:2 has none. Handle stored lowercase → LOWER-join.
    await conn.run(
      `INSERT INTO article_openalex VALUES
       ('repec:aaa:bbb:1','https://openalex.org/W1','10.1/x',
        88, 2.1, 0.95, false, true, true, true, 'gold','https://oa/1',
        'Labour economics','Economics')`,
    );
  }
  return { db: wrap(conn), instance };
}

describe("personPapers openalex badges — table present", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  beforeAll(async () => {
    ({ db, instance } = await makeCorpus(true));
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("attaches the block to a matched paper and null to an unmatched one", async () => {
    const res = await personPapers(db, "pabc", { sortBy: "citations", order: "desc" });
    const matched = res.in_corpus.find((r) => (r as { handle: string }).handle === "RePEc:AAA:bbb:1") as {
      openalex: { fwci: number; is_retracted: boolean; oa_url: string } | null;
    };
    const unmatched = res.in_corpus.find((r) => (r as { handle: string }).handle === "RePEc:AAA:bbb:2") as {
      openalex: unknown;
    };
    expect(matched.openalex).toMatchObject({ fwci: 2.1, is_retracted: true, oa_url: "https://oa/1" });
    expect(unmatched.openalex).toBeNull();
  });
});

describe("personPapers openalex badges — table absent (pre-Track-B)", () => {
  it("omits the openalex key entirely", async () => {
    const { db, instance } = await makeCorpus(false);
    const res = await personPapers(db, "pabc");
    expect(res.in_corpus).toHaveLength(2);
    expect(res.in_corpus[0]).not.toHaveProperty("openalex");
    db.close();
    instance.closeSync();
  });
});
