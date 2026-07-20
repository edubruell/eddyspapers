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

// Only the streaming synthesis stage uses this. A broad brief can produce a full
// MAX_TOKENS_SYNTH (~8k-token) review that legitimately streams for minutes; 120s was
// aborting otherwise-good long runs mid-write. 5 minutes gives generous headroom while
// still surfacing a genuinely stalled/dropped connection. Overridable per call via timeoutMs.
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

export interface StreamResult {
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
}

export async function streamStructured(opts: {
  model: LanguageModelV1;
  modelId: string;
  messages: CoreMessage[];
  stage: string;
  onDelta: (delta: string) => void;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<StreamResult> {
  // A provider that stalls mid-stream (e.g. truncated/dropped connection when a
  // request runs out of budget) would otherwise hang the textStream forever and
  // leave the UI spinner spinning. Abort after a timeout so the failure surfaces.
  let streamError: unknown = null;
  const result = streamText({
    model: opts.model,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS),
    onError: ({ error }) => {
      streamError = error;
    },
  });

  try {
    for await (const delta of result.textStream) {
      opts.onDelta(delta);
    }
  } catch (err) {
    streamError = streamError ?? err;
  }

  if (streamError) {
    const message =
      streamError instanceof Error ? streamError.message : String(streamError);
    throw new Error(`${opts.stage} stream failed: ${message}`);
  }

  const finishReason = await result.finishReason;

  const usage = await result.usage;
  const raw = usage as {
    promptTokens: number;
    completionTokens: number;
    promptTokensDetails?: { cachedTokens?: number };
  };

  const cachedTokens = raw.promptTokensDetails?.cachedTokens ?? 0;

  await logUsage(opts.stage, opts.modelId, raw.promptTokens, raw.completionTokens, cachedTokens);

  return {
    finishReason,
    usage: { promptTokens: raw.promptTokens, completionTokens: raw.completionTokens, cachedTokens },
  };
}
