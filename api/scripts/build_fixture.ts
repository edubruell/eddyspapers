// Builds the test fixture DuckDB (PLAN.md §12.1) from the full local corpus.
// Needs the big articles.duckdb (env chain via resolveSnapshot) — run once per
// snapshot: `npx tsx scripts/build_fixture.ts`. Output is gitignored; tests fail
// with a pointer here when it's missing.
//
// Slice design: a coherent minimum-wage/monopsony core (so keyword + semantic
// tests have real signal), every in-corpus work of the registered authors behind
// that core (so the person rollup behaves realistically), plus recent per-category
// padding (so category filters and the guide see all seven tiers).
import { rm, mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dir, "../tests/fixtures");
const FIXTURE_PATH = join(FIXTURE_DIR, "corpus_fixture.duckdb");
const VEC_PATH = join(FIXTURE_DIR, "query_vec.json");

const snap = await resolveSnapshot();
if (!snap.exists) throw new Error(`full corpus not found (looked at ${snap.path})`);

await mkdir(FIXTURE_DIR, { recursive: true });
await rm(FIXTURE_PATH, { force: true });
await rm(`${FIXTURE_PATH}.wal`, { force: true });

const instance = await DuckDBInstance.create(FIXTURE_PATH);
const conn = await instance.connect();
await conn.run("INSTALL vss");
await conn.run("LOAD vss");
await conn.run(`ATTACH '${snap.path.replace(/'/g, "''")}' AS src (READ_ONLY)`);

await conn.run(`
  CREATE TEMP TABLE picked AS
  WITH mw AS (
    SELECT Handle FROM src.articles
    WHERE LOWER(title) LIKE '%minimum wage%' OR LOWER(title) LIKE '%monopson%'
  ),
  mw_authors AS (
    SELECT short_id FROM (
      SELECT DISTINCT pw.short_id
      FROM src.person_works pw
      JOIN mw ON pw.work_handle = LOWER(mw.Handle)
    ) ORDER BY short_id LIMIT 40
  ),
  author_works AS (
    SELECT DISTINCT a.Handle
    FROM src.person_works pw
    JOIN mw_authors ma ON ma.short_id = pw.short_id
    JOIN src.articles a ON LOWER(a.Handle) = pw.work_handle
  ),
  per_category AS (
    SELECT Handle FROM (
      SELECT Handle, ROW_NUMBER() OVER (PARTITION BY category ORDER BY year DESC, Handle) AS rn
      FROM src.articles WHERE category IS NOT NULL
    ) WHERE rn <= 120
  ),
  quirks AS (
    -- guaranteed coverage for the LIKE-escape / unicode edge tests: titles with a
    -- literal percent sign, a literal backslash, and German umlauts
    SELECT Handle FROM (SELECT Handle FROM src.articles WHERE title LIKE '%\%%' ESCAPE '\' ORDER BY Handle LIMIT 3)
    UNION SELECT Handle FROM (SELECT Handle FROM src.articles WHERE title LIKE '%\\%' ESCAPE '/' ORDER BY Handle LIMIT 2)
    UNION SELECT Handle FROM (SELECT Handle FROM src.articles WHERE LOWER(title) LIKE '%ü%' OR LOWER(title) LIKE '%ö%' ORDER BY Handle LIMIT 3)
  )
  SELECT Handle FROM mw
  UNION SELECT Handle FROM author_works
  UNION SELECT Handle FROM per_category
  UNION SELECT Handle FROM quirks
`);

await conn.run("CREATE TABLE articles AS SELECT a.* FROM src.articles a JOIN picked p ON a.Handle = p.Handle");
await conn.run(
  "CREATE TABLE handle_stats AS SELECT hs.* FROM src.handle_stats hs WHERE hs.handle IN (SELECT LOWER(Handle) FROM articles)",
);
await conn.run(
  // cit_internal stores lowercase handles (like handle_stats/person_works).
  `CREATE TABLE cit_internal AS
   SELECT ci.* FROM src.cit_internal ci
   WHERE ci.citing IN (SELECT LOWER(Handle) FROM articles)
     AND ci.cited IN (SELECT LOWER(Handle) FROM articles)`,
);
await conn.run(
  // cit_all keeps every edge *citing* a fixture paper (citer may be out-of-corpus), so
  // /citationcounts sees total >= internal — the Phase 5 citation-count route needs it.
  `CREATE TABLE cit_all AS
   SELECT ca.* FROM src.cit_all ca
   WHERE ca.cited IN (SELECT LOWER(Handle) FROM articles)`,
);
await conn.run(
  `CREATE TABLE version_links AS
   SELECT vl.* FROM src.version_links vl
   WHERE LOWER(vl.source) IN (SELECT LOWER(Handle) FROM articles)
     AND LOWER(vl.target) IN (SELECT LOWER(Handle) FROM articles)`,
);

// Person tables: authors whose works overlap the slice, with person_works
// restricted to in-fixture articles so rollup counts stay internally consistent.
await conn.run(`
  CREATE TEMP TABLE picked_persons AS
  SELECT DISTINCT pw.short_id
  FROM src.person_works pw
  WHERE pw.work_handle IN (SELECT LOWER(Handle) FROM articles)
`);
await conn.run("CREATE TABLE persons AS SELECT p.* FROM src.persons p JOIN picked_persons pp ON pp.short_id = p.short_id");
await conn.run(
  `CREATE TABLE person_works AS
   SELECT pw.* FROM src.person_works pw
   JOIN picked_persons pp ON pp.short_id = pw.short_id
   WHERE pw.work_handle IN (SELECT LOWER(Handle) FROM articles)`,
);
await conn.run(
  "CREATE TABLE person_stats AS SELECT ps.* FROM src.person_stats ps JOIN picked_persons pp ON pp.short_id = ps.short_id",
);
await conn.run(
  "CREATE TABLE person_wikidata AS SELECT w.* FROM src.person_wikidata w JOIN picked_persons pp ON pp.short_id = w.short_id",
);

await conn.run("CREATE TABLE journals AS SELECT * FROM src.journals");
await conn.run("CREATE TABLE db_metadata AS SELECT * FROM src.db_metadata");

// M8 enrichment tables. article_jel/person_workplaces restrict to the slice;
// the reference tables stay whole (small). Requires a migrated + backfilled
// source DB — failing loudly here beats a fixture that silently lacks them.
await conn.run(
  "CREATE TABLE article_jel AS SELECT j.* FROM src.article_jel j WHERE j.handle IN (SELECT LOWER(Handle) FROM articles)",
);
await conn.run("CREATE TABLE jel_codes AS SELECT * FROM src.jel_codes");
await conn.run(
  "CREATE TABLE person_workplaces AS SELECT pwp.* FROM src.person_workplaces pwp JOIN picked_persons pp ON pp.short_id = pwp.short_id",
);
await conn.run("CREATE TABLE institutions AS SELECT * FROM src.institutions");
await conn.run("CREATE TABLE journal_quality AS SELECT * FROM src.journal_quality");

// A real query vector for Ollama-free tests: the embedding of a canonical
// minimum-wage paper. Searching with a paper's own vector must rank it first —
// the cheapest possible correctness assertion for the vector path.
const vecReader = await conn.run(`
  SELECT Handle, embeddings::JSON AS emb FROM articles
  WHERE LOWER(title) LIKE '%minimum wage%' AND abstract IS NOT NULL AND embeddings IS NOT NULL
  ORDER BY Handle LIMIT 1
`);
const vecRows = await vecReader.getRows();
if (vecRows.length === 0) throw new Error("no embedded minimum-wage paper in slice");
await writeFile(
  VEC_PATH,
  JSON.stringify({ handle: String(vecRows[0][0]), vec: JSON.parse(String(vecRows[0][1])) }),
);

const counts = await (await conn.run(`
  SELECT 'articles' AS t, COUNT(*) AS n FROM articles
  UNION ALL SELECT 'handle_stats', COUNT(*) FROM handle_stats
  UNION ALL SELECT 'cit_internal', COUNT(*) FROM cit_internal
  UNION ALL SELECT 'cit_all', COUNT(*) FROM cit_all
  UNION ALL SELECT 'persons', COUNT(*) FROM persons
  UNION ALL SELECT 'person_works', COUNT(*) FROM person_works
  UNION ALL SELECT 'person_wikidata', COUNT(*) FROM person_wikidata
`)).getRows();
counts.forEach((r) => console.log(`${String(r[0]).padEnd(16)} ${Number(r[1])}`));

conn.disconnectSync();
console.log(`fixture written: ${FIXTURE_PATH}`);
console.log(`query vector:    ${VEC_PATH} (${String(vecRows[0][0])})`);
