import { generateStructured } from "../../llm/structured.js";
import { models, modelIds } from "../models.js";
import { clarifierSystemMessage, clarifierOutputSchema } from "../../prompts/assemble.js";

export type ClarifyResult =
  | { action: "proceed" }
  | { action: "question"; question: string }
  | { action: "reject"; reason: string };

export async function clarify(brief: string): Promise<ClarifyResult> {
  const userPrompt = `<brief>\n${brief}\n</brief>`;

  let object: { done: true } | { done: false; question?: string; reject?: true; reason?: string };
  try {
    ({ object } = await generateStructured({
      model: models.clarifier,
      modelId: modelIds.clarifier,
      messages: [clarifierSystemMessage, { role: "user", content: userPrompt }],
      schema: clarifierOutputSchema,
      stage: "clarify",
    }));
  } catch (err) {
    // On LLM failure, proceed rather than blocking the pipeline
    return { action: "proceed" };
  }

  if (object.done) return { action: "proceed" };
  if ("reject" in object && object.reject) return { action: "reject", reason: object.reason ?? "Brief rejected." };
  if ("question" in object && object.question) return { action: "question", question: object.question };
  return { action: "proceed" };
}
