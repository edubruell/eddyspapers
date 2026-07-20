#!/usr/bin/env node
// Mini Phase-5 benchmark: writer quality + cost across models on diverse brief corpus.
//
// Usage:
//   pnpm benchmark                                  — all models, all briefs
//   pnpm benchmark --models=deepseek/deepseek-v4-flash,qwen/qwen3-coder-30b-a3b-instruct
//   pnpm benchmark --briefs=b01,b05
//   pnpm benchmark --skip-sandbox                   — writer + AST only, no DB needed

import { createInterface } from "readline";
import { createReadStream } from "fs";
import { writeFile, mkdir, appendFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeScript } from "../src/agent/stages/writeScript.js";
import { runSandbox } from "../src/sandbox/runSandbox.js";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pricing map — $/million tokens (from OpenRouter API, queried 2026-05-21)
// ---------------------------------------------------------------------------
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek/deepseek-v4-flash":  { input: 0.11, output: 0.22 },
  "qwen/qwen3.6-35b-a3b":       { input: 0.15, output: 1.00 },
  "anthropic/claude-haiku-4-5": { input: 1.00, output: 5.00 },
  "google/gemini-3.5-flash":    { input: 1.50, output: 9.00 },
  "z-ai/glm-4.5-air":           { input: 0.13, output: 0.85 },
  "qwen/qwen3-coder-next":      { input: 0.11, output: 0.80 },
  "openai/gpt-5.6-luna":        { input: 1.00, output: 6.00 },
};

const DEFAULT_MODELS = Object.keys(MODEL_PRICING);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let models = DEFAULT_MODELS;
  let briefs: string[] | undefined;
  let skipSandbox = false;

  for (const arg of args) {
    if (arg.startsWith("--models=")) {
      models = arg.slice("--models=".length).split(",").map((s) => s.trim());
    } else if (arg.startsWith("--briefs=")) {
      briefs = arg.slice("--briefs=".length).split(",").map((s) => s.trim());
    } else if (arg === "--skip-sandbox") {
      skipSandbox = true;
    }
  }

  return { models, briefs, skipSandbox };
}

// ---------------------------------------------------------------------------
// Brief loading
// ---------------------------------------------------------------------------
type Brief = {
  id: string;
  type: string;
  brief: string;
  categories?: string[];
  min_year?: number | null;
};

async function loadBriefs(filter?: string[]): Promise<Brief[]> {
  const briefs: Brief[] = [];
  const rl = createInterface({
    input: createReadStream(join(__dirname, "../tests/benchmarks/briefs.jsonl")),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const b = JSON.parse(line) as Brief;
    if (!filter || filter.includes(b.id)) briefs.push(b);
  }

  return briefs;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
type RunResult = {
  model: string;
  brief_id: string;
  brief_type: string;
  valid: boolean;
  attempts: number;
  rejection_reason?: string;
  paper_count: number;
  section_count: number;
  write_ms: number;
  sandbox_ms: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  timed_out: boolean;
  sandbox_exit_code?: number;
};

function calcCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------
async function runOne(
  model: string,
  brief: Brief,
  dbPath: string,
  dbDate: string,
  skipSandbox: boolean,
): Promise<RunResult> {
  const base: Omit<RunResult, "valid" | "attempts" | "write_ms"> = {
    model,
    brief_id: brief.id,
    brief_type: brief.type,
    paper_count: 0,
    section_count: 0,
    sandbox_ms: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    timed_out: false,
  };

  const t0 = Date.now();
  const writeResult = await writeScript({
    brief: brief.brief,
    categories: brief.categories ?? undefined,
    minYear: brief.min_year ?? undefined,
    dbDate,
    modelOverride: model,
  });
  const write_ms = Date.now() - t0;

  if (!writeResult.ok) {
    return {
      ...base,
      valid: false,
      attempts: writeResult.attempts,
      rejection_reason: writeResult.reason,
      write_ms,
      cost_usd: calcCost(model, 0, 0),
    };
  }

  const { script, attempts, usage } = writeResult;
  const cost_usd = calcCost(model, usage.promptTokens, usage.completionTokens);

  if (skipSandbox || !dbPath) {
    return {
      ...base,
      valid: true,
      attempts,
      write_ms,
      prompt_tokens: usage.promptTokens,
      cached_tokens: usage.cachedTokens,
      completion_tokens: usage.completionTokens,
      cost_usd,
    };
  }

  // Run sandbox
  const tmp = join(tmpdir(), `bench_${Date.now()}_${Math.random().toString(36).slice(2)}.R`);
  try {
    await writeFile(tmp, script, "utf-8");

    const t1 = Date.now();
    let paperCount = 0;
    let sectionCount = 0;

    const sandboxResult = await runSandbox(tmp, dbPath, (event) => {
      if (event.type === "paper") paperCount++;
      if (event.type === "section") sectionCount++;
    });
    const sandbox_ms = Date.now() - t1;

    return {
      ...base,
      valid: true,
      attempts,
      write_ms,
      sandbox_ms,
      paper_count: paperCount,
      section_count: sectionCount,
      prompt_tokens: usage.promptTokens,
      cached_tokens: usage.cachedTokens,
      completion_tokens: usage.completionTokens,
      cost_usd,
      timed_out: sandboxResult.timedOut,
      sandbox_exit_code: sandboxResult.exitCode ?? undefined,
    };
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------
function printSummary(results: RunResult[], models: string[]) {
  console.log(bold("\n══════════════════════════ SUMMARY ══════════════════════════\n"));

  // Per-model aggregate
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    const valid = rs.filter((r) => r.valid);
    const totalCost = rs.reduce((s, r) => s + r.cost_usd, 0);
    const avgPapers = valid.length > 0
      ? (valid.reduce((s, r) => s + r.paper_count, 0) / valid.length).toFixed(1)
      : "—";
    const firstAttemptValid = rs.filter((r) => r.valid && r.attempts === 1).length;
    const shortModel = model.split("/").pop()!;

    console.log(bold(shortModel));
    console.log(
      `  Valid: ${green(`${valid.length}/${rs.length}`)}` +
      `  (first-attempt: ${firstAttemptValid})` +
      `  Avg papers: ${avgPapers}` +
      `  Total cost: $${totalCost.toFixed(4)}`
    );

    for (const r of rs) {
      const status = r.valid ? green("✓") : red("✗");
      const papers = r.valid ? `${r.paper_count}p ${r.section_count}s` : r.rejection_reason?.slice(0, 40) ?? "failed";
      const timing = r.valid
        ? dim(`${r.write_ms}ms write + ${r.sandbox_ms}ms exec`)
        : dim(`${r.write_ms}ms`);
      console.log(`  ${status} ${r.brief_id} (${r.brief_type}) — ${papers}  ${timing}  $${r.cost_usd.toFixed(5)}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set.");
    process.exit(1);
  }

  const { models, briefs: briefFilter, skipSandbox } = parseArgs();
  const briefs = await loadBriefs(briefFilter);

  if (briefs.length === 0) {
    console.error("No briefs found.");
    process.exit(1);
  }

  // Resolve DB
  const snap = await resolveSnapshot();
  const dbPath = snap.exists ? snap.path : "";
  const dbDate = snap.exists && snap.ageMs != null
    ? new Date(Date.now() - snap.ageMs).toISOString().slice(0, 10)
    : "unknown";

  if (!snap.exists && !skipSandbox) {
    console.log(yellow("⚠  No DB snapshot found — running in writer-only mode (--skip-sandbox implied)"));
  }
  if (snap.stale) {
    console.log(yellow(`⚠  DB snapshot is ${Math.floor((snap.ageMs ?? 0) / 86_400_000)}d old`));
  }

  const effectiveSkipSandbox = skipSandbox || !snap.exists;

  console.log(bold("\n═══ PHASE-5 MINI BENCHMARK ═══\n"));
  console.log(`Models:  ${models.map((m) => m.split("/").pop()).join(", ")}`);
  console.log(`Briefs:  ${briefs.map((b) => b.id).join(", ")}`);
  console.log(`Sandbox: ${effectiveSkipSandbox ? yellow("skipped") : green("enabled")}`);
  console.log(`DB:      ${dbPath || dim("(none)")}`);
  console.log();

  const results: RunResult[] = [];
  const outputDir = join(__dirname, "../tests/benchmarks/results");
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);

  const total = models.length * briefs.length;
  let done = 0;

  for (const brief of briefs) {
    console.log(bold(`\n── ${brief.id} (${brief.type}) ─────────────────────────────`));
    console.log(dim(`   "${brief.brief.slice(0, 80)}${brief.brief.length > 80 ? "…" : ""}"`));

    for (const model of models) {
      const shortModel = model.split("/").pop()!;
      process.stdout.write(`  ${cyan(shortModel.padEnd(40))} `);

      try {
        const result = await runOne(model, brief, dbPath, dbDate, effectiveSkipSandbox);
        results.push(result);
        await appendFile(outPath, JSON.stringify(result) + "\n");
        done++;

        if (result.valid) {
          const papers = effectiveSkipSandbox ? "" : ` ${result.paper_count}p`;
          process.stdout.write(
            green(`✓ attempt ${result.attempts}`) +
            papers +
            dim(` ${result.write_ms}ms $${result.cost_usd.toFixed(5)}`) +
            "\n"
          );
        } else {
          process.stdout.write(
            red(`✗ ${result.rejection_reason?.slice(0, 50) ?? "failed"}`) +
            dim(` [${result.attempts} attempts]`) +
            "\n"
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(red(`  error: ${msg.slice(0, 60)}`) + "\n");
        done++;
      }
    }
  }

  printSummary(results, models);

  // Cost table
  console.log(bold("Cost table ($/run median brief ~7k tokens):"));
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    const totalCost = rs.reduce((s, r) => s + r.cost_usd, 0);
    const perRun = rs.length > 0 ? totalCost / rs.length : 0;
    const shortModel = model.split("/").pop()!.padEnd(40);
    const pricing = MODEL_PRICING[model];
    const pricingNote = pricing ? `in=$${pricing.input}/M out=$${pricing.output}/M` : "";
    console.log(`  ${shortModel} avg/run=$${perRun.toFixed(5)}  ${dim(pricingNote)}`);
  }

  console.log(dim(`\nFull results: ${outPath}`));
  console.log(dim(`Runs: ${done}/${total}`));
}

main().catch((err) => {
  console.error(red(`\nFatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
