import { generateStructured } from "../../llm/structured.js";
import { models, modelIds } from "../models.js";
import { clarifierSystemMessage, clarifierOutputSchema } from "../../prompts/assemble.js";

export type ClarifyResult =
  | { action: "proceed" }
  | { action: "question"; question: string; options: string[] }
  | { action: "reject"; reason: string };

export async function clarify(brief: string, dbDate: string): Promise<ClarifyResult> {
  const userPrompt = `<brief>\n${brief}\n</brief>\n\n<db_snapshot>\n${dbDate}\n</db_snapshot>`;

  let object: {
    assessment?: string;
    action: "proceed" | "ask" | "reject";
    question?: string;
    options?: string[];
    reason?: string;
  };
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

  if (object.action === "reject") return { action: "reject", reason: object.reason ?? "Brief rejected." };
  if (object.action === "ask" && object.question) {
    return { action: "question", question: object.question, options: object.options ?? [] };
  }
  return { action: "proceed" };
}
