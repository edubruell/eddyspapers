import type { CoreMessage } from "ai";
import { z } from "zod";
import { apiReferencePrompt } from "./apiReference.js";
import { journalCategoriesPrompt } from "./journalCategories.js";
import { semanticQueryGuidePrompt } from "./semanticQueryGuide.js";
import { examplesPrompt } from "./examples.js";
import { writerRulesPrompt } from "./writerRules.js";
import { clarifierPrompt } from "./clarifier.js";
import { assessorPrompt } from "./assessor.js";
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

// Multistage assessor (07_multistage.md §3). When the user enables refine the second pass is
// MANDATORY, so the assessor is an *advisor*, not a gate: it always proposes the single most
// valuable next pass (directive + mode) and a user-facing reason. There is no "adequate" escape —
// even a strong round 1 gets one broadening/deepening pass.
export const assessorOutputSchema = z.object({
  assessment: z
    .string()
    .max(400)
    .describe(
      "One sentence judging the round-1 result: is it empty/thin/off-brief and needs fixing, or " +
        "solid but improvable by broadening or deepening?",
    ),
  mode: z
    .enum(["augment", "replace"])
    .describe(
      "'replace' when the round-1 approach was wrong and should be re-derived (discarding it); " +
        "'augment' (the usual choice) when round 1 is fine and this pass should ADD to it.",
    ),
  reason: z
    .string()
    .max(280)
    .describe("One plain-language, user-facing sentence explaining what the refine pass will do — no mechanics."),
  directive: z
    .string()
    .max(600)
    .describe("Concrete instruction to the writer: the specific approach to change or the angle to add, and how."),
});
export type AssessorOutput = z.infer<typeof assessorOutputSchema>;

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

const ASSESSOR_SYSTEM =
  journalCategoriesPrompt + "\n\n" + assessorPrompt;

const SYNTHESIZER_SYSTEM =
  "You are the synthesis stage of a literature search pipeline.\n\n" +
  journalCategoriesPrompt +
  "\n\n" +
  synthesizerPrompt;

// Memoized — assembled once at module load, stable cache key
export const writerSystemMessage: CoreMessage = cachedSystemMessage(WRITER_SYSTEM);
export const clarifierSystemMessage: CoreMessage = cachedSystemMessage(CLARIFIER_SYSTEM);
export const assessorSystemMessage: CoreMessage = cachedSystemMessage(ASSESSOR_SYSTEM);
export const synthesizerSystemMessage: CoreMessage = cachedSystemMessage(SYNTHESIZER_SYSTEM);
