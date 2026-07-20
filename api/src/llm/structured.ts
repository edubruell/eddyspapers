import { generateObject } from "ai";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import type { CoreMessage, LanguageModelV1 } from "ai";

export type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
};

const TELEMETRY_PATH = join(process.cwd(), "data", "llm_telemetry.ndjson");

async function logUsage(stage: string, model: string, usage: UsageSummary) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
  });
  try {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await appendFile(TELEMETRY_PATH, line + "\n");
  } catch {
    // telemetry is best-effort
  }
  console.error(
    `[llm] ${stage} | cached=${usage.cachedTokens}/${usage.promptTokens} prompt | ${usage.completionTokens} completion`
  );
}

export async function generateStructured<T>(opts: {
  model: LanguageModelV1;
  modelId: string;
  messages: CoreMessage[];
  schema: z.ZodType<T>;
  stage: string;
}): Promise<{ object: T; usage: UsageSummary }> {
  const result = await generateObject({
    model: opts.model,
    messages: opts.messages,
    schema: opts.schema,
  });

  const raw = result.usage as {
    promptTokens: number;
    completionTokens: number;
    promptTokensDetails?: { cachedTokens?: number };
  };

  const usage: UsageSummary = {
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
    cachedTokens: raw.promptTokensDetails?.cachedTokens ?? 0,
  };

  await logUsage(opts.stage, opts.modelId, usage);

  return { object: result.object, usage };
}
