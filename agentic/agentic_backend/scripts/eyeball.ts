#!/usr/bin/env node
// Run: pnpm eyeball "<brief>" [--min-year=YYYY] [--categories=cat1,cat2]
// Or:  pnpm tsx --env-file=.env scripts/eyeball.ts "<brief>"

import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeScript } from "../src/agent/stages/writeScript.js";
import { runSandbox } from "../src/sandbox/runSandbox.js";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";
import type { RawSandboxEvent } from "../src/sandbox/events.js";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. Run via: pnpm eyeball \"<brief>\"");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let minYear: number | undefined;
  let categories: string[] | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--min-year=")) {
      minYear = parseInt(arg.slice("--min-year=".length), 10);
    } else if (arg.startsWith("--categories=")) {
      categories = arg.slice("--categories=".length).split(",").map((s) => s.trim());
    } else {
      positional.push(arg);
    }
  }

  return { brief: positional.join(" "), minYear, categories };
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

async function main() {
  const { brief, minYear, categories } = parseArgs(process.argv.slice(2));

  if (!brief) {
    console.error('Usage: pnpm eyeball "<brief>" [--min-year=YYYY] [--categories=cat1,cat2]');
    process.exit(1);
  }

  console.log(bold("\n═══ EYEBALL HARNESS ═══\n"));
  console.log(`Brief:      ${brief}`);
  if (categories) console.log(`Categories: ${categories.join(", ")}`);
  if (minYear)    console.log(`Min year:   ${minYear}`);
  console.log();

  // Resolve DB snapshot
  const snap = await resolveSnapshot();
  if (!snap.exists) {
    console.log(yellow(`⚠  DB snapshot not found at ${snap.path} — sandbox will fail`));
  } else if (snap.stale) {
    const days = Math.floor((snap.ageMs ?? 0) / 86_400_000);
    console.log(yellow(`⚠  Snapshot is ${days}d old`));
  } else {
    console.log(dim(`DB: ${snap.path}`));
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
  console.log(dim("─────────────────────────────────────────────\n"));

  if (!snap.exists) {
    console.log(yellow("Skipping sandbox run — no DB snapshot found."));
    process.exit(0);
  }

  // Sandbox stage
  console.log(bold("── EXECUTE ───────────────────────────────────"));
  const tmp = join(tmpdir(), `eyeball_${Date.now()}.R`);
  try {
    await writeFile(tmp, writeResult.script, "utf-8");

    const t1 = Date.now();
    let paperCount = 0;
    let sectionCount = 0;

    const result = await runSandbox(tmp, snap.path, (event) => {
      printEvent(event);
      if (event.type === "paper") paperCount++;
      if (event.type === "section") sectionCount++;
    });
    const execMs = Date.now() - t1;

    console.log();
    if (result.timedOut) {
      console.log(red("  ⏰ Timed out"));
    } else {
      console.log(green(`  ✓ Exit ${result.exitCode} (${execMs}ms)`));
    }
    console.log(dim(`  ${paperCount} papers, ${sectionCount} sections`));

    if (result.stderr.trim()) {
      console.log(dim("\n── R stderr ──────────────────────────────────"));
      console.log(dim(result.stderr.slice(0, 2000)));
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(red(`\nUnhandled error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
