import type { CoreMessage } from "ai";
import { z } from "zod";
import { apiReferencePrompt } from "./apiReference.js";
import { journalCategoriesPrompt } from "./journalCategories.js";
import { semanticQueryGuidePrompt } from "./semanticQueryGuide.js";
import { examplesPrompt } from "./examples.js";
import { writerRulesPrompt } from "./writerRules.js";
import { clarifierPrompt } from "./clarifier.js";
import { synthesizerPrompt } from "./synthesizer.js";

// Single-object clarifier output with an explicit `action` discriminator. A flat object
// (rather than a union of {done:true} | {…}) stops the model defaulting to the cheapest
// "proceed" branch — it must first assess the brief, then commit to proceed/ask/reject.
// When asking, it offers 2–4 concrete answer options (Claude-Code style); the user can
// always type their own, so options are suggestions, not an exhaustive set.
export const clarifierOutputSchema = z.object({
  assessment: z
    .string()
    .max(400)
    .describe(
      "One sentence: does the brief pin down a clear topic AND an implied mode/scope so that " +
        "one obvious search script follows, or is a script-shaping choice (topic, framing, scope, " +
        "prestige-vs-recency) still left open?",
    ),
  action: z.enum(["proceed", "ask", "reject"]),
  question: z.string().max(280).optional().describe("Required when action is 'ask'."),
  options: z
    .array(z.string().max(120))
    .min(2)
    .max(4)
    .optional()
    .describe("2–4 short concrete answer choices. Required when action is 'ask'."),
  reason: z.string().max(280).optional().describe("Required when action is 'reject'."),
});
export type ClarifierOutput = z.infer<typeof clarifierOutputSchema>;

function cachedSystemMessage(text: string): CoreMessage {
  return {
    role: "system",
    content: text,
    providerOptions: {
      openrouter: { cacheControl: { type: "ephemeral" } },
    },
  };
}

const WRITER_SYSTEM =
  "You are a precise R script writer for an economics literature search system.\n" +
  "Write R scripts that use ONLY the eddysearch.sandbox API described below.\n\n" +
  apiReferencePrompt +
  "\n\n" +
  journalCategoriesPrompt +
  "\n\n" +
  semanticQueryGuidePrompt +
  "\n\n" +
  examplesPrompt +
  "\n\n" +
  writerRulesPrompt +
  "\n\n" +
  "Return a single JSON object: {\"script\": \"<the complete R script>\"}\n" +
  "The script field must contain valid R code. No markdown fences, no explanatory prose — just the script.";

const CLARIFIER_SYSTEM =
  journalCategoriesPrompt + "\n\n" + clarifierPrompt;

const SYNTHESIZER_SYSTEM =
  "You are the synthesis stage of a literature search pipeline.\n\n" +
  journalCategoriesPrompt +
  "\n\n" +
  synthesizerPrompt;

// Memoized — assembled once at module load, stable cache key
export const writerSystemMessage: CoreMessage = cachedSystemMessage(WRITER_SYSTEM);
export const clarifierSystemMessage: CoreMessage = cachedSystemMessage(CLARIFIER_SYSTEM);
export const synthesizerSystemMessage: CoreMessage = cachedSystemMessage(SYNTHESIZER_SYSTEM);
