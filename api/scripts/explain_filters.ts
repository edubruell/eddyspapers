// Plan + row-count probe for filtered semantic search (contention C3): does each
// paperFilters() filter keep HNSW_INDEX_SCAN, and does a narrow filter return fewer
// than k rows? Uses a stored paper embedding as the query, so no Ollama is needed.
// Usage: pnpm exec tsx scripts/explain_filters.ts [snapshot.duckdb] [k]
import { DuckDBInstance } from "@duckdb/node-api";
import { paperFilters } from "../src/search/papers.js";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";

type Filters = Parameters<typeof paperFilters>[0];

const path = process.argv[2] ?? (await resolveSnapshot()).path;
const K = Number(process.argv[3] ?? 100);

const instance = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
const conn = await instance.connect();
await conn.run("LOAD vss");

const rows = async (sql: string, params: unknown[] = []) => {
  const prepared = await conn.prepare(sql);
  params.forEach((v, i) =>
    typeof v === "number" ? prepared.bindInteger(i + 1, v) : prepared.bindVarchar(i + 1, String(v)),
  );
  return (await prepared.runAndReadAll()).getRowObjects();
};

console.log(`snapshot: ${path}, k=${K}`);
console.table(
  await rows(
    "SELECT table_name, index_name, sql FROM duckdb_indexes() ORDER BY table_name, index_name",
  ),
);

const [seed] = await rows(
  "SELECT Handle, embeddings::VARCHAR AS v FROM articles WHERE embeddings IS NOT NULL AND title ILIKE '%minimum wage%' LIMIT 1",
);
const vec = `${String(seed.v)}::FLOAT[1024]`;
const [cat] = await rows(
  "SELECT category FROM articles WHERE category IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) LIMIT 1 OFFSET 3",
);

const cases: [string, Filters][] = [
  ["none", {}],
  ["year>=2015", { minYear: 2015 }],
  [`category=${String(cat.category)}`, { journalFilter: [String(cat.category)] }],
  ["journal~labor economics", { journalName: ["journal of labor economics"] }],
  ["title~minimum wage", { titleKeyword: "minimum wage" }],
  ["author~card", { authorKeyword: "card" }],
  ["jel=J31", { jel: ["J31"] }],
  ["year>=2020 + jel=J3", { minYear: 2020, jel: ["J3"] }],
  ["author~acemoglu + year>=2020", { authorKeyword: "acemoglu", minYear: 2020 }],
];

const topK = (where: string) => `SELECT a.Handle,
    array_cosine_distance(a.embeddings, ${vec}) AS similarity
  FROM articles a ${where}
  ORDER BY similarity ASC LIMIT ${K}`;

const results = [];
for (const [label, f] of cases) {
  const frags = paperFilters(f);
  const where = frags.length ? `WHERE ${frags.map((x) => x.sql).join(" AND ")}` : "";
  const params = frags.flatMap((x) => x.params);
  const plan = (await rows(`EXPLAIN ${topK(where)}`, params))
    .map((r) => String(r.explain_value))
    .join("\n");
  const ops = [...plan.matchAll(/│\s*(HNSW_INDEX_SCAN|SEQ_SCAN|TOP_N|FILTER|HASH_JOIN|PROJECTION)\s*│/g)]
    .map((m) => m[1]);
  const t0 = performance.now();
  const got = await rows(topK(where), params);
  const ms = performance.now() - t0;
  const [{ n }] = await rows(`SELECT COUNT(*) AS n FROM articles a ${where}`, params);
  results.push({
    filter: label,
    hnsw: plan.includes("HNSW_INDEX_SCAN"),
    plan: [...new Set(ops)].join(">"),
    returned: got.length,
    matching: Number(n),
    short: got.length < Math.min(K, Number(n)),
    ms: Math.round(ms),
  });
}
console.table(results);

// Other vector query shapes in the codebase: persons.ts / person_verbs.R rank by
// `1 - distance DESC`; the R sandbox over-fetches an unfiltered pool and filters after.
const shapes: [string, string][] = [
  ["persons: 1-dist DESC", `SELECT a.Handle, 1 - array_cosine_distance(a.embeddings, ${vec}) AS s FROM articles a ORDER BY s DESC LIMIT 1500`],
  ["persons: 1-dist DESC + year", `SELECT a.Handle, 1 - array_cosine_distance(a.embeddings, ${vec}) AS s FROM articles a WHERE a.year >= 2015 ORDER BY s DESC LIMIT 1500`],
  ["pool 1500", topK("").replace(`LIMIT ${K}`, "LIMIT 1500")],
  ["pool 5000", topK("").replace(`LIMIT ${K}`, "LIMIT 5000")],
];
const shapeResults = [];
for (const [label, sql] of shapes) {
  const plan = (await rows(`EXPLAIN ${sql}`)).map((r) => String(r.explain_value)).join("\n");
  const t0 = performance.now();
  const got = await rows(sql);
  shapeResults.push({ shape: label, hnsw: plan.includes("HNSW_INDEX_SCAN"), returned: got.length, ms: Math.round(performance.now() - t0) });
}
console.table(shapeResults);
