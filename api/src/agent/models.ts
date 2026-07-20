import { or } from "../llm/client.js";
import { env } from "../env.js";

export const models = {
  writer:      or(env.MODEL_WRITER),
  writerRetry: or(env.MODEL_WRITER_RETRY),
  clarifier:   or(env.MODEL_CLARIFIER),
  assessor:    or(env.MODEL_ASSESSOR),
  synthesizer: or(env.MODEL_SYNTH),
};

export const modelIds = {
  writer:      env.MODEL_WRITER,
  writerRetry: env.MODEL_WRITER_RETRY,
  clarifier:   env.MODEL_CLARIFIER,
  assessor:    env.MODEL_ASSESSOR,
  synthesizer: env.MODEL_SYNTH,
};
