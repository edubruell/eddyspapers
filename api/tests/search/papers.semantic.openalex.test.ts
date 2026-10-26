import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CorpusDb } from "../../src/db/corpus.js";
import { EMBED_DIM } from "../../src/search/embed.js";
import { semanticSearchWithVector } from "../../src/search/papers.js";

// The OpenAlex metrics join must sit ABOVE the vector top-k, never inside it: a join in the
// same SELECT as `ORDER BY array_cosine_distance(...) LIMIT k` stops the VSS optimizer from
// rewriting the scan into an HNSW_INDEX_SCAN, and prod degrades to a full scan of every
// embedding (~2s vs ~10ms, measured 2026-08-30). Lifting the join onto a top-k CTE costs the
// row order, which a hash join does not preserve — both properties are pinned here.
// array_cosine_distance is core DuckDB, so this needs no vss extension.

const sqlLog: string[] = [];

const wrap = (conn: Awaited<ReturnType<DuckDBInstance["connect"]>>): CorpusDb =>
  ({
    query: async (sql: string, params?: unknown[]) => {
      sqlLog.push(sql);
      const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
      const names = reader.columnNames();
      const rows = await reader.getRows();
      return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
    },
    close: () => conn.disconnectSync(),
  }) as CorpusDb;

// Four papers whose embeddings sit at known distances from the probe [1,0,0]; only the
// first and third carry an article_openalex row, so a reordering join would be visible.
async function makeCorpus(withOpenAlex = true): Promise<{ db: CorpusDb; instance: DuckDBInstance }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(`
    CREATE TABLE articles (
      Handle VARCHAR, title VARCHAR, year INTEGER, authors VARCHAR, journal VARCHAR,
      category VARCHAR, url VARCHAR, doi VARCHAR, bib_tex VARCHAR, abstract VARCHAR,
      embeddings FLOAT[${EMBED_DIM}]
    )`);
  // Only the first two components vary; the rest are zero-padded to the corpus dimension
  // that vectorLiteral casts to.
  const emb = (x: number, y: number): string =>
    `[${[x, y, ...Array(EMBED_DIM - 2).fill(0)].join(",")}]::FLOAT[${EMBED_DIM}]`;
  await conn.run(
    `INSERT INTO articles VALUES
     ('RePEc:AAA:bbb:1','Nearest',2019,'Card','AER','A','http://x/1','10.1/x','@a{}','a',${emb(1.0, 0.0)}),
     ('RePEc:AAA:bbb:2','Second',2020,'Card','QJE','A','http://x/2','10.1/y','@b{}','b',${emb(0.9, 0.1)}),
     ('RePEc:AAA:bbb:3','Third',2021,'Krueger','JPE','A','http://x/3',NULL,'@c{}','c',${emb(0.5, 0.5)}),
     ('RePEc:AAA:bbb:4','Farthest',2022,'Krueger','REStat','A','http://x/4',NULL,'@d{}','d',${emb(0.0, 1.0)})`,
  );

  await conn.run("CREATE TABLE article_jel (handle VARCHAR, jel_code VARCHAR)");
  await conn.run(
    "INSERT INTO article_jel VALUES ('repec:aaa:bbb:2','E24'), ('repec:aaa:bbb:3','J31'), ('repec:aaa:bbb:4','J24')",
  );
  if (!withOpenAlex) return { db: wrap(conn), instance };

  await conn.run(`
    CREATE TABLE article_openalex (
      handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
      oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
      is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
      is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
      primary_topic VARCHAR, primary_field VARCHAR
    )`);
  // Lowercase handles, as the pipeline writes them — the LOWER-join is the recurring hazard.
  await conn.run(
    `INSERT INTO article_openalex VALUES
     ('repec:aaa:bbb:1','https://openalex.org/W1','10.1/x',42,1.75,0.9,false,true,false,true,'gold','https://oa/1','Labour economics','Economics'),
     ('repec:aaa:bbb:3','https://openalex.org/W3','10.1/z',7,0.5,0.2,false,false,true,false,NULL,NULL,'Macro','Economics')`,
  );
  return { db: wrap(conn), instance };
}

describe("semanticSearchWithVector with article_openalex", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  const probe = [1, 0, ...Array(EMBED_DIM - 2).fill(0)];

  beforeAll(async () => {
    ({ db, instance } = await makeCorpus());
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("keeps the join out of the top-k so the HNSW rewrite survives", async () => {
    sqlLog.length = 0;
    await semanticSearchWithVector(db, probe, {});
    const sql = sqlLog.find((s) => s.includes("array_cosine_distance"));
    expect(sql).toBeDefined();
    const topK = sql!.slice(0, sql!.indexOf("LIMIT"));
    expect(topK).not.toContain("article_openalex");
    expect(sql).toContain("WITH top AS");
  });

  it("returns rows in ascending distance order across the join", async () => {
    const rows = await semanticSearchWithVector(db, probe, {});
    expect(rows.map((r) => r.Handle)).toEqual([
      "RePEc:AAA:bbb:1",
      "RePEc:AAA:bbb:2",
      "RePEc:AAA:bbb:3",
      "RePEc:AAA:bbb:4",
    ]);
    expect(rows.map((r) => r.similarity)).toEqual([...rows.map((r) => r.similarity)].sort((a, b) => a - b));
  });

  it("attaches the openalex block only to matched handles", async () => {
    const rows = await semanticSearchWithVector(db, probe, {});
    expect(rows[0].openalex).toMatchObject({
      openalex_id: "https://openalex.org/W1",
      oa_cited_by_count: 42,
      fwci: 1.75,
      is_retracted: false,
      is_oa: true,
      oa_url: "https://oa/1",
      primary_field: "Economics",
    });
    expect(rows[1].openalex).toBeNull();
    expect(rows[2].openalex).toMatchObject({ is_retracted: true, oa_status: null });
  });

  it("applies row filters through the pooled top-k", async () => {
    const rows = await semanticSearchWithVector(db, probe, { minYear: 2021, maxK: 10 });
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:3", "RePEc:AAA:bbb:4"]);
    expect(rows[0].openalex?.openalex_id).toBe("https://openalex.org/W3");
  });

  it("keeps filters out of the index top-k and widens to an exact scan when the pool runs short", async () => {
    sqlLog.length = 0;
    // A pool of 1 holds only the nearest paper (2019), which the year filter drops.
    const rows = await semanticSearchWithVector(db, probe, { minYear: 2020, maxK: 10 }, 1);
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:2", "RePEc:AAA:bbb:3", "RePEc:AAA:bbb:4"]);
    expect(rows[1].openalex?.openalex_id).toBe("https://openalex.org/W3");

    const [pooled, exact] = sqlLog;
    const indexTopK = pooled.slice(pooled.indexOf("SELECT a.Handle"), pooled.indexOf("LIMIT"));
    expect(indexTopK).not.toContain("WHERE");
    expect(exact).toContain(") + 0 AS similarity");
    expect(sqlLog).toHaveLength(2);
  });

  it("skips the exact scan when the pool fills k", async () => {
    sqlLog.length = 0;
    const rows = await semanticSearchWithVector(db, probe, { minYear: 2020, maxK: 2 });
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:2", "RePEc:AAA:bbb:3"]);
    expect(sqlLog).toHaveLength(1);
  });

  it("honours maxK after the join", async () => {
    const rows = await semanticSearchWithVector(db, probe, { maxK: 2 });
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:1", "RePEc:AAA:bbb:2"]);
  });

  // Several filters bind several params: the pool size must lead and k must trail on the
  // pooled shape, and the exact shape must bind the same filter params without the pool.
  it("binds mixed filter params in the same order on the pooled and exact shapes", async () => {
    const filters = { minYear: 2020, journalFilter: ["A"], authorKeyword: "krueger", jel: ["j3"], maxK: 10 };
    sqlLog.length = 0;
    const pooled = await semanticSearchWithVector(db, probe, filters);
    const exact = await semanticSearchWithVector(db, probe, filters, 1);
    expect(pooled.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:3"]);
    expect(exact).toEqual(pooled);
    expect(sqlLog).toHaveLength(4);
    expect(sqlLog[0]).toContain("EXISTS (SELECT 1 FROM article_jel");
  });

  it("resolves a JEL prefix filter against the pooled CTE", async () => {
    const rows = await semanticSearchWithVector(db, probe, { jel: ["J"], maxK: 2 });
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:3", "RePEc:AAA:bbb:4"]);
    expect(rows[0].openalex?.openalex_id).toBe("https://openalex.org/W3");
  });

  it("returns nothing, after one exact scan, when a filter matches no paper", async () => {
    sqlLog.length = 0;
    const rows = await semanticSearchWithVector(db, probe, { authorKeyword: "nobody", maxK: 10 });
    expect(rows).toEqual([]);
    expect(sqlLog).toHaveLength(2);
  });

  it("returns nothing for maxK 0 without falling back", async () => {
    sqlLog.length = 0;
    expect(await semanticSearchWithVector(db, probe, { maxK: 0 })).toEqual([]);
    expect(await semanticSearchWithVector(db, probe, { minYear: 2020, maxK: 0 })).toEqual([]);
    expect(sqlLog).toHaveLength(2);
  });
});

describe("semanticSearchWithVector without article_openalex", () => {
  let db: CorpusDb;
  let instance: DuckDBInstance;
  const probe = [1, 0, ...Array(EMBED_DIM - 2).fill(0)];

  beforeAll(async () => {
    ({ db, instance } = await makeCorpus(false));
  });
  afterAll(() => {
    db.close();
    instance.closeSync();
  });

  it("runs the pooled shape bare and returns the plain paper shape", async () => {
    sqlLog.length = 0;
    const rows = await semanticSearchWithVector(db, probe, { authorKeyword: "card", maxK: 2 });
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:1", "RePEc:AAA:bbb:2"]);
    expect(rows.every((r) => !("openalex" in r))).toBe(true);
    const searches = sqlLog.filter((s) => s.includes("array_cosine_distance"));
    expect(searches).toHaveLength(1);
    expect(searches[0]).not.toContain("WITH top AS");
    expect(searches[0]).toMatch(/^WITH a AS/);
  });

  it("falls back to the bare exact scan when the pool runs short", async () => {
    sqlLog.length = 0;
    const rows = await semanticSearchWithVector(db, probe, { jel: ["J"], minYear: 2021, maxK: 5 }, 1);
    expect(rows.map((r) => r.Handle)).toEqual(["RePEc:AAA:bbb:3", "RePEc:AAA:bbb:4"]);
    expect(rows.every((r) => !("openalex" in r))).toBe(true);
    const searches = sqlLog.filter((s) => s.includes("array_cosine_distance"));
    expect(searches).toHaveLength(2);
    expect(searches[1]).toMatch(/^SELECT a\.Handle/);
    expect(searches[1]).toContain(") + 0 AS similarity");
  });
});
