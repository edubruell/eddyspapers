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
  | { ok: false; reason: string; attempts: number };

const scriptSchema = z.object({ script: z.string() });

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

    const { object, usage } = await generateStructured({
      model,
      modelId,
      messages: [writerSystemMessage, { role: "user", content: userPrompt }],
      schema: scriptSchema,
      stage: `write:attempt${attempt}`,
    });

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
