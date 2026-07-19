import { streamStructured } from "../../llm/stream.js";
import { models, modelIds } from "../models.js";
import { env } from "../../env.js";
import { synthesizerSystemMessage } from "../../prompts/assemble.js";
import type { Section, Paper, Person } from "../types.js";

const TRUNCATION_NOTICE =
  "\n\n---\n\n_The synthesis was cut off at the model's output-length limit. " +
  "The evidence below is complete; consider narrowing the brief for a tighter review._";

export async function synthesize(
  brief: string,
  script: string,
  sections: Section[],
  papers: Record<string, Paper>,
  persons: Record<string, Person>,
  bibtex: string,
  dbDate: string,
  onDelta: (delta: string) => void,
): Promise<string> {
  const personsBlock = Object.keys(persons ?? {}).length
    ? `<persons>\n${JSON.stringify(persons, null, 2)}\n</persons>\n\n`
    : "";

  const userMessage =
    `<brief>\n${brief}\n</brief>\n\n` +
    `<db_snapshot>\n${dbDate}\n</db_snapshot>\n\n` +
    `<script>\n${script}\n</script>\n\n` +
    `<sections>\n${JSON.stringify(sections, null, 2)}\n</sections>\n\n` +
    `<papers>\n${JSON.stringify(papers, null, 2)}\n</papers>\n\n` +
    personsBlock +
    `<bibtex>\n${bibtex}\n</bibtex>`;

  let accumulated = "";
  const { finishReason } = await streamStructured({
    model: models.synthesizer,
    modelId: modelIds.synthesizer,
    messages: [synthesizerSystemMessage, { role: "user", content: userMessage }],
    stage: "synthesize",
    maxTokens: env.MAX_TOKENS_SYNTH,
    onDelta: (delta) => {
      accumulated += delta;
      onDelta(delta);
    },
  });

  if (finishReason === "length") {
    onDelta(TRUNCATION_NOTICE);
    accumulated += TRUNCATION_NOTICE;
  }

  return accumulated;
}
