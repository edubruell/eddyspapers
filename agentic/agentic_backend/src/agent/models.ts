import { or } from "../llm/client.js";
import { env } from "../env.js";

export const models = {
  writer:      or(env.MODEL_WRITER),
  writerRetry: or(env.MODEL_WRITER_RETRY),
  clarifier:   or(env.MODEL_CLARIFIER),
  synthesizer: or(env.MODEL_SYNTH),
};

export const modelIds = {
  writer:      env.MODEL_WRITER,
  writerRetry: env.MODEL_WRITER_RETRY,
  clarifier:   env.MODEL_CLARIFIER,
  synthesizer: env.MODEL_SYNTH,
};
