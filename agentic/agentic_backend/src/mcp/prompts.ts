import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Named MCP prompt templates (01_design.md §7.7) — they keep small calling models
// on-pattern without re-deriving the lit-search heuristics. Each expands its args
// into a well-shaped brief. lit_review hands the brief to the lit_search pipeline in
// one call (§7.7); find_referees and journal_scan stay on the cheap tools because
// person-overlap and exhaustive single-journal sweeps are genuinely better served by
// find_people / paged keyword_search than by the synthesising pipeline.

const userText = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "lit_review",
    {
      title: "Literature review",
      description: "Shape a topic into a literature-search brief and run it against the corpus.",
      argsSchema: {
        topic: z.string().describe("The research topic or question"),
        purpose: z.string().optional().describe("paper | grant | cover-letter (tunes emphasis)"),
      },
    },
    ({ topic, purpose }) =>
      userText(
        `Do a literature review on: ${topic}.` +
          (purpose ? ` Intended purpose: ${purpose}.` : "") +
          ` Call lit_search with a brief written as a few sentences of abstract-style prose describing ` +
          `the mechanism, method, and context of interest — not keyword labels. It returns a finished ` +
          `synthesis, a BibTeX bundle, and a CSV in one call; present the synthesis and cite the ` +
          `returned handles. If lit_search reports needs_clarification, sharpen the brief and re-call it.`,
      ),
  );

  server.registerPrompt(
    "find_referees",
    {
      title: "Find referees / editors",
      description: "Find candidate referees or editors working on a topic, optionally in a journal.",
      argsSchema: {
        topic: z.string().describe("The paper's topic or contribution"),
        journal: z.string().optional().describe("Target journal, if referees should match it"),
      },
    },
    ({ topic, journal }) =>
      userText(
        `Find candidate referees for a paper on: ${topic}.` +
          (journal ? ` Prefer authors who publish in ${journal}.` : "") +
          ` Call find_people with the topic written as abstract-style prose; use scoring_mode='breadth' ` +
          `to reward authors with sustained work in the area, and set active_since to the last ~8 years ` +
          `to favour currently active researchers. Report each candidate with their matched papers as ` +
          `evidence.`,
      ),
  );

  server.registerPrompt(
    "journal_scan",
    {
      title: "Single-journal scan",
      description: "Exhaustively scan one journal for papers on given keywords.",
      argsSchema: {
        journal: z.string().describe("Journal name (substring match)"),
        keywords: z.string().optional().describe("Comma-separated keywords to sweep"),
      },
    },
    ({ journal, keywords }) =>
      userText(
        `Scan the journal "${journal}" exhaustively` +
          (keywords ? ` for work on: ${keywords}.` : ".") +
          ` Use keyword_search with journal_name="${journal}"` +
          (keywords ? ` and keywords=[${keywords.split(",").map((k) => `"${k.trim()}"`).join(", ")}]` : "") +
          `, ordering by citations to surface the most established work first. Page through with ` +
          `limit/offset until the results are exhausted.`,
      ),
  );
}
