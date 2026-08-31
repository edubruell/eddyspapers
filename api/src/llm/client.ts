import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "../env.js";

const _or = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

// extraBody rides through to the OpenRouter request body — used to turn OFF reasoning on
// models that default to it (Qwen 3.8), where thinking buys nothing and costs latency.
export const or = (modelId: string, extraBody?: Record<string, unknown>) =>
  extraBody ? _or(modelId, { extraBody }) : _or(modelId);
