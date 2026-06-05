import { streamStructured } from "../../llm/stream.js";
import { models, modelIds } from "../models.js";
import { synthesizerSystemMessage } from "../../prompts/assemble.js";
import type { Section, Paper } from "../types.js";

export async function synthesize(
  brief: string,
  script: string,
  sections: Section[],
  papers: Record<string, Paper>,
  bibtex: string,
  onDelta: (delta: string) => void,
): Promise<string> {
  const userMessage =
    `<brief>\n${brief}\n</brief>\n\n` +
    `<script>\n${script}\n</script>\n\n` +
    `<sections>\n${JSON.stringify(sections, null, 2)}\n</sections>\n\n` +
    `<papers>\n${JSON.stringify(papers, null, 2)}\n</papers>\n\n` +
    `<bibtex>\n${bibtex}\n</bibtex>`;

  let accumulated = "";
  await streamStructured({
    model: models.synthesizer,
    modelId: modelIds.synthesizer,
    messages: [synthesizerSystemMessage, { role: "user", content: userMessage }],
    stage: "synthesize",
    onDelta: (delta) => {
      accumulated += delta;
      onDelta(delta);
    },
  });

  return accumulated;
}
