export const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
  MODEL_WRITER:       process.env.MODEL_WRITER       ?? "anthropic/claude-haiku-4-5",
  MODEL_WRITER_RETRY: process.env.MODEL_WRITER_RETRY ?? "anthropic/claude-haiku-4-5",
  MODEL_CLARIFIER:    process.env.MODEL_CLARIFIER    ?? "anthropic/claude-haiku-4-5",
  MODEL_ASSESSOR:     process.env.MODEL_ASSESSOR     ?? "anthropic/claude-haiku-4-5",
  MODEL_SYNTH:        process.env.MODEL_SYNTH        ?? "anthropic/claude-haiku-4-5",
  MAX_TOKENS_SYNTH:   Number(process.env.MAX_TOKENS_SYNTH ?? 8000),
  // SEMANTIC_API_BASE / EDDYPAPERS_API_KEY were removed in phase 5 (M4): /stats/last_updated
  // now reads the corpus db_metadata directly instead of proxying the Plumber API, so the
  // Node service no longer holds the semantic-search key. The migrate script still reads
  // EDDYPAPERS_API_KEY straight from process.env to register the nginx frontend key.
  // Shared password gating the costly LLM routes. Empty string disables the gate
  // (dev convenience); set it in production to keep the per-query spend behind a wall.
  AGENTIC_PASSWORD:   process.env.AGENTIC_PASSWORD   ?? "",
} as const;
