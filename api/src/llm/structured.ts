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

// Qwen 3.8 returns an empty/unparseable tool call under the SDK's default tool-mode
// structured output, but produces valid objects in json mode. Route those models
// explicitly rather than letting `auto` pick tool-calling and fail all three attempts.
const JSON_MODE_MODELS = /^qwen\/qwen3\.8-/;

export const structuredMode = (modelId: string): "auto" | "json" =>
  JSON_MODE_MODELS.test(modelId) ? "json" : "auto";

// The writer returns ~3k tokens in 25-35s. A provider stall once held a lit_search open for
// ten minutes before the escalation to the retry model could run; the signal covers the SDK's
// own retries too, so this caps the whole call. Every caller already treats a throw as
// "fall back" (escalate, skip refine, proceed without clarifying).
const DEFAULT_STRUCTURED_TIMEOUT_MS = 90_000;

export async function generateStructured<T>(opts: {
  model: LanguageModelV1;
  modelId: string;
  messages: CoreMessage[];
  schema: z.ZodType<T>;
  stage: string;
  timeoutMs?: number;
}): Promise<{ object: T; usage: UsageSummary }> {
  const started = Date.now();
  const result = await generateObject({
    model: opts.model,
    messages: opts.messages,
    schema: opts.schema,
    mode: structuredMode(opts.modelId),
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[llm] ${opts.stage} FAILED | ${opts.modelId} | ${Date.now() - started}ms | ${message.slice(0, 500)}`);
    throw err;
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
