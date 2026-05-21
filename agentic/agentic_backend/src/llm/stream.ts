import { streamText } from "ai";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import type { CoreMessage, LanguageModelV1 } from "ai";

const TELEMETRY_PATH = join(process.cwd(), "data", "llm_telemetry.ndjson");

async function logUsage(stage: string, model: string, promptTokens: number, completionTokens: number, cachedTokens: number) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    model,
    promptTokens,
    completionTokens,
    cachedTokens,
  });
  try {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await appendFile(TELEMETRY_PATH, line + "\n");
  } catch {
    // telemetry is best-effort
  }
  console.error(
    `[llm] ${stage} | cached=${cachedTokens}/${promptTokens} prompt | ${completionTokens} completion`
  );
}

export async function streamStructured(opts: {
  model: LanguageModelV1;
  modelId: string;
  messages: CoreMessage[];
  stage: string;
  onDelta: (delta: string) => void;
}): Promise<void> {
  const result = streamText({
    model: opts.model,
    messages: opts.messages,
  });

  for await (const delta of result.textStream) {
    opts.onDelta(delta);
  }

  const usage = await result.usage;
  const raw = usage as {
    promptTokens: number;
    completionTokens: number;
    promptTokensDetails?: { cachedTokens?: number };
  };

  await logUsage(
    opts.stage,
    opts.modelId,
    raw.promptTokens,
    raw.completionTokens,
    raw.promptTokensDetails?.cachedTokens ?? 0
  );
}
