import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CorpusDb } from "../../src/db/corpus.js";
import { openalexStatsOf } from "../../src/search/citations.js";

// Direct unit coverage for openalexStatsOf against a hand-built article_openalex table:
// exercises the LOWER-join on the mixed-case corpus Handle, the null-metrics mapping, and
// the information_schema existence guard — coverage the fixture route test defers until a
// fixture rebuild (the committed fixture predates Track B).

let tmp = "";
let instance: DuckDBInstance;
let db: CorpusDb;

async function makeDb(path: string, withTable: boolean): Promise<CorpusDb> {
  instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  if (withTable) {
    await conn.run(`
      CREATE TABLE article_openalex (
        handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
        oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
        is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
        is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
        primary_topic VARCHAR, primary_field VARCHAR
      )`);
    // A fully-populated row with a MIXED-case handle, and a null-metrics row.
    await conn.run(
      `INSERT INTO article_openalex VALUES
       ('RePEc:AAA:bbb:1','https://openalex.org/W123','10.1/x',
        42, 1.75, 0.9, false, true, false, true, 'gold','https://oa.example/x',
        'Labour economics','Economics'),
       ('RePEc:AAA:bbb:2', NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    );
  } else {
    await conn.run("CREATE TABLE unrelated (x INTEGER)");
  }
  return {
    query: async (sql: string, params?: unknown[]) => {
      const reader = params ? await conn.run(sql, params as never) : await conn.run(sql);
      const names = reader.columnNames();
      const rows = await reader.getRows();
      return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
    },
    close: () => conn.disconnectSync(),
  } as CorpusDb;
}

afterAll(async () => {
  db?.close();
  instance?.closeSync();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("openalexStatsOf", () => {
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oa-stats-"));
  });

  it("maps a populated row and matches the handle case-insensitively", async () => {
    db = await makeDb(join(tmp, "a.duckdb"), true);
    // Query with a different case than stored — the LOWER-join must still hit.
    const oa = await openalexStatsOf(db, "repec:aaa:BBB:1");
    expect(oa).not.toBeNull();
    expect(oa!.oa_cited_by_count).toBe(42);
    expect(oa!.fwci).toBeCloseTo(1.75);
    expect(oa!.is_top10).toBe(true);
    expect(oa!.is_retracted).toBe(false);
    expect(oa!.openalex_id).toBe("https://openalex.org/W123");
    expect(oa!.oa_url).toBe("https://oa.example/x");
    expect(oa!.primary_topic).toBe("Labour economics");
    db.close();
    instance.closeSync();
  });

  it("maps a row with all-null metrics to nulls (not undefined/NaN)", async () => {
    db = await makeDb(join(tmp, "b.duckdb"), true);
    const oa = await openalexStatsOf(db, "RePEc:AAA:bbb:2");
    expect(oa).not.toBeNull();
    expect(oa!.oa_cited_by_count).toBeNull();
    expect(oa!.fwci).toBeNull();
    expect(oa!.is_top10).toBeNull();
    expect(oa!.openalex_id).toBeNull();
    db.close();
    instance.closeSync();
  });

  it("returns null for an unknown handle", async () => {
    db = await makeDb(join(tmp, "c.duckdb"), true);
    expect(await openalexStatsOf(db, "RePEc:none:0")).toBeNull();
    db.close();
    instance.closeSync();
  });

  it("returns null (no throw) when the article_openalex table is absent", async () => {
    db = await makeDb(join(tmp, "d.duckdb"), false);
    expect(await openalexStatsOf(db, "RePEc:AAA:bbb:1")).toBeNull();
  });
});
