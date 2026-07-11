// Golden-file parity harness (PLAN.md §12.1): compares the Hono search core
// against the Plumber reference on a fixed battery.
//
//   record  — replay the battery against a running Plumber (local or prod) and
//             store goldens:   npx tsx scripts/parity.ts record [--base URL]
//             (needs EDDYPAPERS_API_KEY unless the base injects it)
//   check   — run the same battery through the Node service fns against the
//             local corpus and diff:  npx tsx scripts/parity.ts check
//
// Comparison is rank-tolerant for embedding-backed routes: top-20 handle overlap
// >= 18/20 for /search, top-10 short_id overlap >= 8/10 for /person/search, and
// |Δ similarity| < 1e-3 on common handles (embedding-drift guard).
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { openCorpusDb } from "../src/db/corpus.js";
import { semanticSearch } from "../src/search/papers.js";
import { personSearch } from "../src/search/persons.js";
import type { ScoringMode } from "../src/search/types.js";
import { normalizeForParity, firstDiff } from "./parityNormalize.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const BATTERY_PATH = join(__dir, "parity_battery.json");
const GOLDEN_PATH = join(__dir, "../tests/fixtures/golden/parity_golden.json");

type SemanticCase = { id: string; query: string; min_year: number | null; journal_filter: string | null };
// quality_weight stays 0 in the battery: prod's persons.R had a vectorised-ifelse
// bug (fixed locally 2026-07-10) that made the blend a constant, so blended mode /
// nonzero weights only become parity-comparable after the next R package deploy.
type PersonCase = {
  id: string;
  query: string;
  scoring_mode: ScoringMode;
  quality_weight: number;
  min_year?: number;
  category?: string;
  active_since?: number;
  min_citations?: number;
};
// Pure-SQL routes (citations / stats / person profile-papers-lookup) compared exactly after
// normalisation (unwrap Plumber's boxing, round doubles to jsonlite's 4 digits, drop volatile
// keys). Exactness assumes the local corpus == the recorded snapshot — true at the cutover
// window (§12.3), less so against a stale local copy, where growing citation counts will diff.
type SqlCase = { id: string; method: "GET" | "POST"; path: string; body?: unknown };
type Battery = { semantic: SemanticCase[]; person: PersonCase[]; sql: SqlCase[] };

type SemanticGolden = { id: string; handles: string[]; similarities: number[] };
type PersonGolden = { id: string; short_ids: string[] };
type SqlGolden = { id: string; response: unknown };
type Golden = {
  base: string;
  recorded_at: string;
  semantic: SemanticGolden[];
  person: PersonGolden[];
  sql: SqlGolden[];
};

const SEM_K = 20;
const PER_K = 10;
const SEM_MIN_OVERLAP = 18;
const PER_MIN_OVERLAP = 8;
// Measured local-vs-prod drift is ~8e-5 (jsonlite rounding + identical Ollama
// model), so PLAN §12.1's 1e-4 gate holds even recording against prod. The
// per-query maxΔsim printout doubles as the embedding-drift guard.
const SIM_TOLERANCE = 1e-4;

// Plumber has no secondary sort key on several routes, so tie order is engine-nondeterministic
// and three battery cases can't be compared byte-for-byte even against an identical corpus
// (verified 2026-07-11: citedby's LIMIT 20 cuts inside card2012's 10-paper 2023 year group;
// pca271's top_journals ranks 3-4 tie at n=10; out_of_corpus has no ORDER BY at all):
//  - cites/citedby: membership inside the boundary year is arbitrary — compare length + the
//    year multiset exactly, and row contents exactly on the handles both sides returned.
//  - person profile/papers: sort tie groups canonically on both sides, then compare exact.
type Row = Record<string, unknown>;
const CITATION_SET = /^(cites_|citedby_)/;
// normalizeForParity collapses a 1-row array to a bare object — re-wrap it, or a 1-row
// citation case compares vacuously (review finding, 2026-07-11).
const asRows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v as Row[]) : v && typeof v === "object" ? [v as Row] : [];

function diffCitationSet(golden: unknown, ours: unknown): string | null {
  const g = asRows(golden);
  const o = asRows(ours);
  if (g.length !== o.length) return `$: length ${g.length} vs ${o.length}`;
  for (const [side, rows] of [["golden", g], ["ours", o]] as const) {
    if (new Set(rows.map((r) => String(r.handle))).size !== rows.length) {
      return `$: duplicate handles on ${side} side`;
    }
  }
  const years = (rows: Row[]): string => rows.map((r) => String(r.year ?? "null")).sort().join(",");
  if (years(g) !== years(o)) return `$: year multiset [${years(g)}] vs [${years(o)}]`;
  // Membership may only differ inside the LIMIT-boundary year (the minimum year present);
  // rows on both sides must match exactly.
  const boundaryYear = Math.min(...[...g, ...o].map((r) => Number(r.year ?? Infinity)));
  const byHandle = new Map(o.map((r) => [String(r.handle), r]));
  for (const row of g) {
    const other = byHandle.get(String(row.handle));
    if (!other) {
      if (Number(row.year ?? Infinity) !== boundaryYear) {
        return `$[${String(row.handle)}]: missing from ours outside the boundary year`;
      }
      continue;
    }
    const d = firstDiff(row, other, `$[${String(row.handle)}]`);
    if (d) return d;
  }
  const gHandles = new Set(g.map((r) => String(r.handle)));
  for (const row of o) {
    if (!gHandles.has(String(row.handle)) && Number(row.year ?? Infinity) !== boundaryYear) {
      return `$[${String(row.handle)}]: extra in ours outside the boundary year`;
    }
  }
  return null;
}

const byCountDescThenName = (a: Row, b: Row): number =>
  Number(b.n ?? 0) - Number(a.n ?? 0) ||
  String(a.journal ?? a.category ?? "").localeCompare(String(b.journal ?? b.category ?? ""));
const byWorkHandle = (a: Row, b: Row): number =>
  String(a.work_handle ?? "").localeCompare(String(b.work_handle ?? ""));
const sortIf = (v: unknown, cmp: (a: Row, b: Row) => number): unknown =>
  Array.isArray(v) ? [...(v as Row[])].sort(cmp) : v;

const CANONICALISE: Record<string, (v: unknown) => unknown> = {
  person_profile_card: (v) => ({
    ...(v as Row),
    top_journals: sortIf((v as Row).top_journals, byCountDescThenName),
    category_breakdown: sortIf((v as Row).category_breakdown, byCountDescThenName),
  }),
  person_papers_card: (v) => ({
    ...(v as Row),
    out_of_corpus: sortIf((v as Row).out_of_corpus, byWorkHandle),
  }),
};

const battery = JSON.parse(await readFile(BATTERY_PATH, "utf8")) as Battery;
const mode = process.argv[2];
const baseArg = process.argv.indexOf("--base");
const base = baseArg > -1 ? process.argv[baseArg + 1] : "https://econpapers.eduard-bruell.de/api";

async function record(): Promise<void> {
  const key = process.env.EDDYPAPERS_API_KEY ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>[]> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Record<string, unknown>[];
  };

  const semantic: SemanticGolden[] = [];
  for (const c of battery.semantic) {
    const rows = await post("/search", {
      query: c.query,
      max_k: SEM_K,
      ...(c.min_year != null ? { min_year: c.min_year } : {}),
      ...(c.journal_filter ? { journal_filter: c.journal_filter } : {}),
    });
    semantic.push({
      id: c.id,
      handles: rows.map((r) => String(r.Handle)),
      similarities: rows.map((r) => Number(r.similarity)),
    });
    console.log(`recorded ${c.id}: ${rows.length} rows`);
  }

  const person: PersonGolden[] = [];
  for (const c of battery.person) {
    const res = (await post("/person/search", {
      query: c.query,
      scoring_mode: c.scoring_mode,
      k_papers: 600,
      quality_weight: c.quality_weight,
      limit: PER_K,
      ...(c.min_year != null ? { min_year: c.min_year } : {}),
      ...(c.category ? { category: c.category } : {}),
      ...(c.active_since != null ? { active_since: c.active_since } : {}),
      ...(c.min_citations != null ? { min_citations: c.min_citations } : {}),
    })) as unknown as { results: { short_id: string }[] };
    // Plumber (jsonlite) wraps scalars in one-element arrays; String() unwraps.
    person.push({ id: c.id, short_ids: res.results.map((r) => String(r.short_id)) });
    console.log(`recorded ${c.id}: ${res.results.length} persons`);
  }

  const sql: SqlGolden[] = [];
  for (const c of battery.sql) {
    const res = await fetch(`${base}${c.path}`, {
      method: c.method,
      headers,
      body: c.method === "POST" ? JSON.stringify(c.body ?? {}) : undefined,
    });
    if (!res.ok) throw new Error(`${c.path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    sql.push({ id: c.id, response: await res.json() });
    console.log(`recorded ${c.id}`);
  }

  await mkdir(dirname(GOLDEN_PATH), { recursive: true });
  const golden: Golden = { base, recorded_at: new Date().toISOString(), semantic, person, sql };
  await writeFile(GOLDEN_PATH, JSON.stringify(golden, null, 2));
  console.log(`golden written: ${GOLDEN_PATH}`);
}

async function check(): Promise<void> {
  const golden = JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as Golden;
  const db = await openCorpusDb();
  const failures: string[] = [];

  console.log(`golden base: ${golden.base} (recorded ${golden.recorded_at})`);
  console.log(`corpus:      ${db.snapshot.path}\n`);

  for (const c of battery.semantic) {
    const g = golden.semantic.find((x) => x.id === c.id);
    if (!g) continue;
    const ours = await semanticSearch(db, {
      query: c.query,
      maxK: SEM_K,
      minYear: c.min_year,
      journalFilter: c.journal_filter ? c.journal_filter.split(",").map((s) => s.trim()) : null,
    });
    const ourHandles = ours.map((r) => r.Handle);
    const overlap = g.handles.filter((h) => ourHandles.includes(h)).length;
    const simDrift = Math.max(
      0,
      ...g.handles.flatMap((h, i) => {
        const j = ourHandles.indexOf(h);
        return j > -1 ? [Math.abs(g.similarities[i] - ours[j].similarity)] : [];
      }),
    );
    const ok = overlap >= SEM_MIN_OVERLAP && simDrift < SIM_TOLERANCE;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.id}  overlap ${overlap}/${SEM_K}  top1=${ourHandles[0] === g.handles[0] ? "same" : "diff"}  maxΔsim=${simDrift.toExponential(1)}`,
    );
    if (!ok) failures.push(c.id);
  }

  for (const c of battery.person) {
    const g = golden.person.find((x) => x.id === c.id);
    if (!g) continue;
    const ours = await personSearch(db, {
      query: c.query,
      scoringMode: c.scoring_mode,
      kPapers: 600,
      qualityWeight: c.quality_weight,
      maxK: PER_K,
      minYear: c.min_year ?? null,
      journalFilter: c.category ? c.category.split(",").map((s) => s.trim()) : null,
      activeSince: c.active_since ?? null,
      minCitations: c.min_citations ?? null,
    });
    const ourIds = ours.map((r) => r.short_id);
    const overlap = g.short_ids.filter((s) => ourIds.includes(s)).length;
    const ok = overlap >= PER_MIN_OVERLAP;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.id}  overlap ${overlap}/${PER_K}  top1=${ourIds[0] === g.short_ids[0] ? "same" : "diff"}`);
    if (!ok) failures.push(c.id);
  }

  // SQL routes: drive the real Hono app (wire-level, so rounding/boxing/field-order are
  // exercised) and diff exactly-after-normalisation against the Plumber goldens.
  if (golden.sql?.length) {
    process.env.DB_SNAPSHOT = db.snapshot.path;
    process.env.AGENTIC_APPDATA_PATH ??= join(__dir, "../tests/fixtures/parity_appdata.duckdb");
    delete process.env.AGENTIC_PASSWORD;
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    for (const c of battery.sql) {
      const g = golden.sql.find((x) => x.id === c.id);
      if (!g) continue;
      const res = await app.request(c.path, {
        method: c.method,
        headers: { "content-type": "application/json" },
        body: c.method === "POST" ? JSON.stringify(c.body ?? {}) : undefined,
      });
      const ours = await res.json();
      const canon = CANONICALISE[c.id] ?? ((x: unknown): unknown => x);
      const gN = canon(normalizeForParity(g.response));
      const oN = canon(normalizeForParity(ours));
      const diff = CITATION_SET.test(c.id) ? diffCitationSet(gN, oN) : firstDiff(gN, oN);
      const ok = res.status === 200 && diff === null;
      console.log(`${ok ? "PASS" : "FAIL"} ${c.id}${diff ? "  " + diff : ""}`);
      if (!ok) failures.push(c.id);
    }
  }

  db.close();
  if (failures.length > 0) {
    console.error(`\nPARITY FAIL: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nPARITY OK");
}

if (mode === "record") await record();
else if (mode === "check") await check();
else {
  console.error("usage: parity.ts record [--base URL] | check");
  process.exit(1);
}
