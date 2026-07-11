// Phase 1 spike (PLAN.md §9): prove array_cosine_distance works from @duckdb/node-api
// against a READ_ONLY corpus snapshot, with the query vector embedded via local Ollama.
// Kept as a deploy-time validation script.
//
// Finding (2026-07-10): idx_hnsw was built with the default l2sq metric, so cosine
// queries CANNOT use it — in Node *or* in R/Plumber, which has been full-scanning all
// along. An l2sq probe (`array_distance`) does hit HNSW_INDEX_SCAN read-only from Node,
// so index-accelerated search needs only a pipeline-side rebuild WITH (metric='cosine').
// Until then, "plan uses HNSW index: false" below is expected and matches prod behaviour.
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";

const OLLAMA = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434";
const QUERY =
  "Causal effects of minimum wage increases on employment in monopsonistic labour markets. " +
  "Quasi-experimental evidence from regional variation and border-county designs.";

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mxbai-embed-large", input: text }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

const snap = await resolveSnapshot();
if (!snap.exists) throw new Error(`no snapshot found at ${snap.path}`);
console.log(`snapshot: ${snap.path}`);

const t0 = performance.now();
const instance = await DuckDBInstance.create(snap.path, { access_mode: "READ_ONLY" });
const conn = await instance.connect();
await conn.run("INSTALL vss");
await conn.run("LOAD vss");
console.log(`open+LOAD vss: ${(performance.now() - t0).toFixed(0)}ms`);

const vec = await embed(QUERY);
if (vec.length !== 1024) throw new Error(`expected 1024-dim embedding, got ${vec.length}`);
const vecLit = `[${vec.join(",")}]::FLOAT[1024]`;

const sql = (v: string) => `
  SELECT a.Handle, a.title, a.year,
         array_cosine_distance(a.embeddings, ${v}) AS similarity
  FROM articles a
  ORDER BY similarity ASC
  LIMIT 20`;

// Prove the HNSW index is actually used (not a full scan).
const explain = await conn.run(`EXPLAIN ${sql(vecLit)}`);
const plan = (await explain.getRows()).map((r) => r.join(" ")).join("\n");
const usesIndex = plan.includes("HNSW_INDEX_SCAN");
console.log(`plan uses HNSW index: ${usesIndex}`);
if (!usesIndex) console.log(plan);

for (const run of [1, 2]) {
  const t = performance.now();
  const reader = await conn.run(sql(vecLit));
  const rows = await reader.getRows();
  console.log(`query run ${run}: ${rows.length} rows in ${(performance.now() - t).toFixed(0)}ms`);
  if (run === 1)
    rows
      .slice(0, 5)
      .forEach((r) => console.log(`  ${Number(r[3]).toFixed(4)}  ${r[2]}  ${String(r[1]).slice(0, 70)}`));
}

// Filtered variant (year + category) — the shape /search actually runs; with a WHERE
// clause the planner may fall back to a scan, worth knowing the cost either way.
const tf = performance.now();
const filtered = await conn.run(`
  SELECT a.Handle, array_cosine_distance(a.embeddings, ${vecLit}) AS similarity
  FROM articles a
  WHERE a.year >= 2015 AND a.category IN ('Top 5 Journals','Top Field Journals (A)')
  ORDER BY similarity ASC
  LIMIT 20`);
console.log(`filtered query: ${(await filtered.getRows()).length} rows in ${(performance.now() - tf).toFixed(0)}ms`);

conn.disconnectSync();
console.log("SPIKE OK");
