#!/usr/bin/env node
// Qualitative comparison: run both models on one brief, show scripts + section structure side by side.
// Usage: pnpm qual b01   (brief id from briefs.jsonl)

import { createInterface } from "readline";
import { createReadStream } from "fs";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeScript } from "../src/agent/stages/writeScript.js";
import { runSandbox } from "../src/sandbox/runSandbox.js";
import { resolveSnapshot } from "../src/sandbox/snapshot.js";
import type { RawSandboxEvent } from "../src/sandbox/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODELS = ["qwen/qwen3.6-35b-a3b", "anthropic/claude-haiku-4-5"];

type Brief = { id: string; type: string; brief: string; categories?: string[]; min_year?: number | null };

async function loadBrief(id: string): Promise<Brief | undefined> {
  const rl = createInterface({ input: createReadStream(join(__dirname, "../tests/benchmarks/briefs.jsonl")), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const b = JSON.parse(line) as Brief;
    if (b.id === id) return b;
  }
}

const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan  = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow= (s: string) => `\x1b[33m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;

type SectionRecord = { title: string; note?: string; papers: string[] };

type RunRecord = {
  model: string;
  script: string;
  sections: SectionRecord[];
  notes: string[];
  totalPapers: number;
  writeMs: number;
  sandboxMs: number;
  costUsd: number;
};

async function runOne(model: string, brief: Brief, dbPath: string, dbDate: string): Promise<RunRecord> {
  const t0 = Date.now();
  const result = await writeScript({ brief: brief.brief, categories: brief.categories ?? undefined, minYear: brief.min_year ?? undefined, dbDate, modelOverride: model });
  const writeMs = Date.now() - t0;

  if (!result.ok) {
    throw new Error(`Write failed: ${result.reason}`);
  }

  const { script, usage } = result;
  const pricing: Record<string, { input: number; output: number }> = {
    "qwen/qwen3.6-35b-a3b":       { input: 0.15, output: 1.00 },
    "anthropic/claude-haiku-4-5": { input: 1.00, output: 5.00 },
  };
  const p = pricing[model] ?? { input: 0, output: 0 };
  const costUsd = (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1_000_000;

  const tmp = join(tmpdir(), `qual_${Date.now()}.R`);
  await writeFile(tmp, script, "utf-8");

  const sections: SectionRecord[] = [];
  const notes: string[] = [];
  const paperTitles: Record<string, string> = {};
  let currentSectionHandles: string[] = [];

  const t1 = Date.now();
  try {
    await runSandbox(tmp, dbPath, (event: RawSandboxEvent) => {
      if (event.type === "paper") {
        paperTitles[event.handle] = `${event.title} (${event.year}) — ${event.authors?.split(";")[0]?.trim() ?? ""}`;
      }
      if (event.type === "section") {
        currentSectionHandles = event.handles ?? [];
        sections.push({
          title: event.title,
          note: event.note ?? undefined,
          papers: currentSectionHandles.slice(0, 4).map((h) => paperTitles[h] ?? h),
        });
      }
      if (event.type === "note") {
        notes.push(event.markdown ?? "");
      }
    });
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const sandboxMs = Date.now() - t1;

  const totalPapers = Object.keys(paperTitles).length;
  return { model, script, sections, notes, totalPapers, writeMs, sandboxMs, costUsd };
}

async function main() {
  const briefId = process.argv[2];
  if (!briefId) { console.error("Usage: pnpm qual <brief-id>  e.g. pnpm qual b01"); process.exit(1); }

  const brief = await loadBrief(briefId);
  if (!brief) { console.error(`Brief ${briefId} not found`); process.exit(1); }

  const snap = await resolveSnapshot();
  if (!snap.exists) { console.error("No DB snapshot found"); process.exit(1); }
  const dbDate = snap.ageMs != null ? new Date(Date.now() - snap.ageMs).toISOString().slice(0, 10) : "unknown";

  console.log(bold(`\n═══ QUAL COMPARE — ${briefId} (${brief.type}) ═══\n`));
  console.log(dim(`"${brief.brief.slice(0, 120)}${brief.brief.length > 120 ? "…" : ""}"\n`));

  const records: RunRecord[] = [];
  for (const model of MODELS) {
    const short = model.split("/").pop()!;
    process.stdout.write(cyan(`Running ${short}…`) + "\n");
    try {
      const rec = await runOne(model, brief, snap.path, dbDate);
      records.push(rec);
      console.log(green(`  ✓ ${rec.totalPapers} papers, ${rec.sections.length} sections  ${rec.writeMs}ms write  $${rec.costUsd.toFixed(5)}\n`));
    } catch (err) {
      console.log(red(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`));
    }
  }

  // Side-by-side comparison
  for (const rec of records) {
    const short = rec.model.split("/").pop()!;
    console.log(bold(`\n${"─".repeat(70)}`));
    console.log(bold(`${short}  —  ${rec.totalPapers} papers, ${rec.sections.length} sections  $${rec.costUsd.toFixed(5)}`));
    console.log(bold(`${"─".repeat(70)}\n`));

    if (rec.notes.length > 0) {
      console.log(yellow("Notes:"));
      rec.notes.forEach((n) => console.log(dim(`  ${n.slice(0, 120)}`)));
      console.log();
    }

    console.log(cyan("Sections:"));
    rec.sections.forEach((s, i) => {
      console.log(`  ${i + 1}. ${bold(s.title)}`);
      if (s.note) console.log(dim(`     → ${s.note.slice(0, 100)}`));
      s.papers.forEach((p) => console.log(dim(`     • ${p.slice(0, 90)}`)));
    });

    console.log(cyan("\nScript:"));
    console.log(dim(rec.script.split("\n").map((l) => `  ${l}`).join("\n")));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
