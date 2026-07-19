#!/usr/bin/env node
// Synthesis-model A/B: replay real stored searches through several models and compare
// output + cost. Input is the share-DTO JSON of a stored run (brief + events), so every
// arm gets byte-identical input reconstructed from what the sandbox actually returned.
//   pnpm tsx scripts/synth_ab.ts <run.json> [<run.json>...]
// Writes <outDir>/<searchId>/<model>.md plus a cost.tsv summary.

import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { or } from "../src/llm/client.js";
import { streamStructured } from "../src/llm/stream.js";
import { synthesizerSystemMessage } from "../src/prompts/assemble.js";
import { buildSynthesisUserMessage } from "../src/agent/stages/synthesize.js";
import type { StreamEvent, Paper, Person, Section } from "../src/agent/types.js";

const MODELS = [
  "anthropic/claude-haiku-4-5",
  "z-ai/glm-5.2",
  "qwen/qwen3.7-plus",
];

// $/token, in/out — from the OpenRouter model list. Used only for the cost report.
const PRICING: Record<string, { in: number; out: number }> = {
  "anthropic/claude-haiku-4-5": { in: 1.0e-6, out: 5.0e-6 },
  "z-ai/glm-5.2": { in: 0.23e-6, out: 0.71e-6 },
  "qwen/qwen3.7-plus": { in: 0.32e-6, out: 1.28e-6 },
};

const OUT_DIR = process.env.AB_OUT ?? join(process.cwd(), "data", "synth_ab");

interface ShareDto {
  id: string;
  brief: string;
  events: StreamEvent[];
}

// Fold the event stream back into the shape runAgent hands the synthesizer. Mirrors the
// accumulation in runAgent/executeScript: papers and persons keyed by id, sections in
// arrival order, script concatenated from its deltas, last bibtex bundle wins.
function reconstruct(events: StreamEvent[]) {
  const papers: Record<string, Paper> = {};
  const persons: Record<string, Person> = {};
  const sections: Section[] = [];
  let script = "";
  let bibtex = "";

  for (const e of events) {
    if (e.type === "paper") papers[e.paper.handle] = e.paper;
    else if (e.type === "person") persons[e.person.short_id] = e.person;
    else if (e.type === "section") sections.push(e.section);
    else if (e.type === "script") script += e.delta;
    else if (e.type === "bibtex") bibtex = e.bibtex;
  }

  return { papers, persons, sections, script, bibtex };
}

async function runOne(modelId: string, userMessage: string) {
  let text = "";
  const t0 = Date.now();
  const { finishReason, usage } = await streamStructured({
    model: or(modelId),
    modelId,
    messages: [synthesizerSystemMessage, { role: "user", content: userMessage }],
    stage: "synthesize:ab",
    maxTokens: 8000,
    onDelta: (d) => {
      text += d;
    },
  });
  return { text, finishReason, usage, ms: Date.now() - t0 };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: pnpm tsx scripts/synth_ab.ts <run.json> [<run.json>...]");
    process.exit(1);
  }

  const costRows: string[] = ["search\tmodel\tin_tok\tout_tok\tusd\tms\tchars\tfinish"];

  for (const file of files) {
    const dto = JSON.parse(await readFile(file, "utf8")) as ShareDto;
    const { papers, persons, sections, script, bibtex } = reconstruct(dto.events);

    // dbDate is not carried on the share DTO; hold it fixed across arms so it never
    // becomes a source of between-model variance.
    const userMessage = buildSynthesisUserMessage(
      dto.brief,
      script,
      sections,
      papers,
      persons,
      bibtex,
      "2026-07-11",
    );

    const dir = join(OUT_DIR, dto.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "_input.txt"), userMessage);

    console.error(
      `\n=== ${dto.id} — ${Object.keys(papers).length} papers, ${sections.length} sections, ` +
        `${userMessage.length} chars input ===`,
    );

    for (const modelId of MODELS) {
      try {
        const { text, finishReason, usage, ms } = await runOne(modelId, userMessage);
        const p = PRICING[modelId];
        const usd = p ? usage.promptTokens * p.in + usage.completionTokens * p.out : NaN;

        const slug = modelId.replace(/[^a-z0-9.]+/gi, "_");
        await writeFile(join(dir, `${slug}.md`), `<!-- ${modelId} | ${usd.toFixed(4)} USD | ${ms}ms -->\n\n${text}`);

        costRows.push(
          [dto.id, modelId, usage.promptTokens, usage.completionTokens, usd.toFixed(4), ms, text.length, finishReason].join("\t"),
        );
        console.error(`  ${modelId.padEnd(28)} ${String(usage.promptTokens).padStart(7)} in  ${String(usage.completionTokens).padStart(5)} out  $${usd.toFixed(4)}  ${ms}ms  ${text.length} chars  [${finishReason}]`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        costRows.push([dto.id, modelId, "-", "-", "-", "-", "-", `ERROR: ${msg}`].join("\t"));
        console.error(`  ${modelId.padEnd(28)} ERROR: ${msg}`);
      }
    }
  }

  await writeFile(join(OUT_DIR, "cost.tsv"), costRows.join("\n") + "\n");
  console.error(`\nwrote ${OUT_DIR}/cost.tsv`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
