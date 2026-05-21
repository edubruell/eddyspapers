import type { CoreMessage } from "ai";
import { apiReferencePrompt } from "./apiReference.js";
import { journalCategoriesPrompt } from "./journalCategories.js";
import { semanticQueryGuidePrompt } from "./semanticQueryGuide.js";
import { examplesPrompt } from "./examples.js";
import { writerRulesPrompt } from "./writerRules.js";
import { clarifierPrompt } from "./clarifier.js";
import { synthesizerPrompt } from "./synthesizer.js";

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
