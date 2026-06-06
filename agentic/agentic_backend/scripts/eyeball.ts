#!/usr/bin/env node
// Run a brief through write + execute and print everything (script, events, stderr).
//   pnpm eyeball "<brief>" [--min-year=YYYY] [--categories=cat1,cat2]
// Debug a failing script directly, skipping the LLM (hand-edit then re-run):
//   pnpm eyeball --script=path/to/script.R
// On any failure (validation, timeout, non-zero exit) the script + full stderr + events
// are written to data/agentic/debug/<timestamp>/ and the path is printed for inspection.

import { writeFile, unlink, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeScript } from "../src/agent/stages/writeScript.js";
import { runSandbox } from "../src/sandbox/runSandbox.js";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";
import type { RawSandboxEvent } from "../src/sandbox/events.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let minYear: number | undefined;
  let categories: string[] | undefined;
  let scriptPath: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--min-year=")) {
      minYear = parseInt(arg.slice("--min-year=".length), 10);
    } else if (arg.startsWith("--categories=")) {
      categories = arg.slice("--categories=".length).split(",").map((s) => s.trim());
    } else if (arg.startsWith("--script=")) {
      scriptPath = arg.slice("--script=".length);
    } else {
      positional.push(arg);
    }
  }

  return { brief: positional.join(" "), minYear, categories, scriptPath };
}

function dim(s: string)   { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string)  { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string){ return `\x1b[33m${s}\x1b[0m`; }
function red(s: string)   { return `\x1b[31m${s}\x1b[0m`; }

function printEvent(e: RawSandboxEvent) {
  switch (e.type) {
    case "progress":
      console.log(dim(`  ⏳ ${e.label}${e.current != null ? ` (${e.current}${e.total != null ? `/${e.total}` : ""})` : ""}`));
      break;
    case "paper":
      console.log(`  📄 ${e.title} (${e.year}) — ${e.authors}`);
      console.log(dim(`     ${e.journal} | ${e.category} | ${e.handle}`));
      break;
    case "section":
      console.log(bold(`\n  ── ${e.title} (${e.handles.length} papers) ──`));
      if (e.note) console.log(dim(`     ${e.note}`));
      break;
    case "bibtex":
      console.log(green(`  📚 BibTeX: ${e.handles?.length ?? e.entries ?? 0} entries`));
      break;
    case "note":
      console.log(yellow(`  📝 ${e.markdown}`));
      break;
    case "error":
      console.log(red(`  ❌ ${e.message} (recoverable: ${e.recoverable})`));
      break;
  }
}

// Persist script + full stderr + events for post-mortem inspection.
async function dumpArtifacts(script: string, stderr: string, events: RawSandboxEvent[]): Promise<string> {
  const dir = join(process.cwd(), "data", "agentic", "debug", `${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "script.R"), script, "utf-8");
  await writeFile(join(dir, "stderr.txt"), stderr, "utf-8");
  await writeFile(join(dir, "events.json"), JSON.stringify(events, null, 2), "utf-8");
  return dir;
}

// Run a script string in the sandbox, print events, dump artifacts on failure.
async function execute(script: string): Promise<boolean> {
  const snap = await resolveSnapshot();
  if (!snap.exists) {
    console.log(yellow(`⚠  DB snapshot not found at ${snap.path} — cannot execute.`));
    return false;
  }
  console.log(dim(`DB: ${snap.path}${snap.stale ? ` (stale, ${Math.floor((snap.ageMs ?? 0) / 86_400_000)}d old)` : ""}`));

  console.log(bold("\n── EXECUTE ───────────────────────────────────"));
  const tmp = join(tmpdir(), `eyeball_${Date.now()}.R`);
  const events: RawSandboxEvent[] = [];
  try {
    await writeFile(tmp, script, "utf-8");

    const t1 = Date.now();
    let paperCount = 0;
    let sectionCount = 0;

    const result = await runSandbox(tmp, snap.path, (event) => {
      events.push(event);
      printEvent(event);
      if (event.type === "paper") paperCount++;
      if (event.type === "section") sectionCount++;
    });
    const execMs = Date.now() - t1;

    const failed = result.timedOut || result.exitCode !== 0;
    console.log();
    if (result.timedOut) {
      console.log(red("  ⏰ Timed out"));
    } else if (failed) {
      console.log(red(`  ✗ Exit ${result.exitCode} (${execMs}ms)`));
    } else {
      console.log(green(`  ✓ Exit ${result.exitCode} (${execMs}ms)`));
    }
    console.log(dim(`  ${paperCount} papers, ${sectionCount} sections`));

    if (result.stderr.trim()) {
      console.log(dim("\n── R stderr ──────────────────────────────────"));
      console.log(dim(result.stderr.slice(0, 4000)));
    }

    if (failed) {
      const dir = await dumpArtifacts(script, result.stderr, events);
      console.log(yellow(`\n📁 Artifacts written to ${dir}`));
      console.log(yellow(`   Hand-edit script.R there, then re-run: pnpm eyeball --script="${join(dir, "script.R")}"`));
    }
    return !failed;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function main() {
  const { brief, minYear, categories, scriptPath } = parseArgs(process.argv.slice(2));

  console.log(bold("\n═══ EYEBALL HARNESS ═══\n"));

  // ── Direct-script mode: skip the LLM, run a raw .R file against the snapshot. ──
  if (scriptPath) {
    console.log(`Script:     ${scriptPath}`);
    const script = await readFile(scriptPath, "utf-8");
    const ok = await execute(script);
    process.exit(ok ? 0 : 1);
  }

  // ── Brief mode: write a script with the LLM, then execute it. ──
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set. Run via: pnpm eyeball "<brief>"');
    process.exit(1);
  }
  if (!brief) {
    console.error('Usage: pnpm eyeball "<brief>" [--min-year=YYYY] [--categories=cat1,cat2]');
    console.error('   or: pnpm eyeball --script=path/to/script.R');
    process.exit(1);
  }

  console.log(`Brief:      ${brief}`);
  if (categories) console.log(`Categories: ${categories.join(", ")}`);
  if (minYear)    console.log(`Min year:   ${minYear}`);
  console.log();

  const snap = await resolveSnapshot();
  if (!snap.exists) {
    console.log(yellow(`⚠  DB snapshot not found at ${snap.path} — sandbox will be skipped`));
  } else if (snap.stale) {
    const days = Math.floor((snap.ageMs ?? 0) / 86_400_000);
    console.log(yellow(`⚠  Snapshot is ${days}d old`));
  }
  console.log();

  // Write stage
  console.log(bold("── WRITE ─────────────────────────────────────"));
  const t0 = Date.now();
  const writeResult = await writeScript({
    brief,
    categories,
    minYear,
    dbDate: snap.exists && snap.ageMs != null ? new Date(Date.now() - snap.ageMs).toISOString().slice(0, 10) : "unknown",
  });
  const writeMs = Date.now() - t0;

  if (!writeResult.ok) {
    console.log(red(`\nFAILED after ${writeResult.attempts} attempt(s): ${writeResult.reason}`));
    process.exit(1);
  }

  console.log(green(`\n✓ Valid script on attempt ${writeResult.attempts} (${writeMs}ms)`));
  console.log(dim(`  Tokens: ${writeResult.usage.promptTokens} prompt (${writeResult.usage.cachedTokens} cached), ${writeResult.usage.completionTokens} completion`));
  console.log();
  console.log(dim("── Script ────────────────────────────────────"));
  console.log(writeResult.script);
  console.log(dim("─────────────────────────────────────────────"));

  if (!snap.exists) {
    console.log(yellow("\nSkipping sandbox run — no DB snapshot found."));
    process.exit(0);
  }

  const ok = await execute(writeResult.script);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(red(`\nUnhandled error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
