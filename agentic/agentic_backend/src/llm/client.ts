import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "../env.js";

const _or = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

export const or = (modelId: string) => _or(modelId);
