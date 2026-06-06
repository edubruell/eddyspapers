export const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
  MODEL_WRITER:       process.env.MODEL_WRITER       ?? "anthropic/claude-haiku-4-5",
  MODEL_WRITER_RETRY: process.env.MODEL_WRITER_RETRY ?? "anthropic/claude-haiku-4-5",
  MODEL_CLARIFIER:    process.env.MODEL_CLARIFIER    ?? "anthropic/claude-haiku-4-5",
  MODEL_ASSESSOR:     process.env.MODEL_ASSESSOR     ?? "anthropic/claude-haiku-4-5",
  MODEL_SYNTH:        process.env.MODEL_SYNTH        ?? "anthropic/claude-haiku-4-5",
  MAX_TOKENS_SYNTH:   Number(process.env.MAX_TOKENS_SYNTH ?? 8000),
  SEMANTIC_API_BASE:  process.env.SEMANTIC_API_BASE  ?? "https://econpapers.eduard-bruell.de/api",
  EDDYPAPERS_API_KEY: process.env.EDDYPAPERS_API_KEY ?? "",
} as const;
