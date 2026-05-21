import { z } from "zod";
import { generateStructured, type UsageSummary } from "../../llm/structured.js";
import { models, modelIds } from "../models.js";
import { writerSystemMessage } from "../../prompts/assemble.js";
import { checkScript } from "../../sandbox/checkScript.js";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export type WriteScriptOpts = {
  brief: string;
  categories?: string[];
  minYear?: number;
  mustInclude?: string[];
  dbDate: string;
};

export type WriteScriptResult =
  | { ok: true; script: string; attempts: number; usage: UsageSummary }
  | { ok: false; reason: string; attempts: number }
  | { ok: false; rejected: true; reason: string; attempts: 0 };

const scriptSchema = z.object({ script: z.string() });

export function preflight(brief: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = brief.trim();
  if (trimmed.length < 15) {
    return { ok: false, reason: "Brief is too short to search for — please describe what you're looking for." };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: "Brief exceeds 2000 characters — please shorten it." };
  }
  const wordLike = trimmed.match(/[a-zA-ZÀ-öø-ÿ]{3,}/g);
  if (!wordLike || wordLike.length < 3) {
    return { ok: false, reason: "Brief doesn't contain enough readable text — please describe the topic in plain words." };
  }
  return { ok: true };
}

function buildUserMessage(
  brief: string,
  categories: string[] | undefined,
  minYear: number | undefined,
  mustInclude: string[] | undefined,
  dbDate: string,
  previousAttempt?: string,
  rejection?: { reason: string; offendingNode: string; hint: string }
): string {
  const filterLines = [
    categories && categories.length > 0 ? `categories: ${categories.join(", ")}` : null,
    minYear != null ? `min_year: ${minYear}` : null,
    mustInclude && mustInclude.length > 0 ? `must_include: ${mustInclude.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let msg =
    `<brief>\n${brief}\n</brief>\n\n` +
    `<filters>\n${filterLines || "(none)"}\n</filters>\n\n` +
    `<db_snapshot>\n${dbDate}\n</db_snapshot>`;

  if (previousAttempt && rejection) {
    msg +=
      `\n\n<previous_attempt>\n${previousAttempt}\n</previous_attempt>\n\n` +
      `<rejection>\nReason: ${rejection.reason}\n` +
      (rejection.offendingNode ? `Offending: ${rejection.offendingNode}\n` : "") +
      (rejection.hint ? `Hint: ${rejection.hint}\n` : "") +
      `</rejection>`;
  }

  return msg;
}

async function checkAndGetRejection(script: string): Promise<
  { ok: true } | { ok: false; reason: string; offendingNode: string; hint: string }
> {
  const tmp = join(tmpdir(), `eddysearch_${Date.now()}_${Math.random().toString(36).slice(2)}.R`);
  try {
    await writeFile(tmp, script, "utf-8");
    const result = await checkScript(tmp);
    return result;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export async function writeScript(opts: WriteScriptOpts): Promise<WriteScriptResult> {
  const { brief, categories, minYear, mustInclude, dbDate } = opts;

  const check = preflight(brief);
  if (!check.ok) return { ok: false, rejected: true, reason: check.reason, attempts: 0 };

  let lastScript: string | undefined;
  let lastRejection: { reason: string; offendingNode: string; hint: string } | undefined;
  let totalUsage: UsageSummary = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const model = attempt <= 2 ? models.writer : models.writerRetry;
    const modelId = attempt <= 2 ? modelIds.writer : modelIds.writerRetry;

    const userPrompt = buildUserMessage(
      brief,
      categories,
      minYear,
      mustInclude,
      dbDate,
      lastScript,
      lastRejection
    );

    let object: { script: string };
    let usage: UsageSummary;
    try {
      ({ object, usage } = await generateStructured({
        model,
        modelId,
        messages: [writerSystemMessage, { role: "user", content: userPrompt }],
        schema: scriptSchema,
        stage: `write:attempt${attempt}`,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `LLM error on attempt ${attempt}: ${message}`, attempts: attempt };
    }

    totalUsage = {
      promptTokens: totalUsage.promptTokens + usage.promptTokens,
      completionTokens: totalUsage.completionTokens + usage.completionTokens,
      cachedTokens: totalUsage.cachedTokens + usage.cachedTokens,
    };

    const script = object.script;
    const check = await checkAndGetRejection(script);

    if (check.ok) {
      return { ok: true, script, attempts: attempt, usage: totalUsage };
    }

    lastScript = script;
    lastRejection = { reason: check.reason, offendingNode: check.offendingNode, hint: check.hint };
  }

  return {
    ok: false,
    reason: lastRejection?.reason ?? "unknown validation error",
    attempts: 3,
  };
}
