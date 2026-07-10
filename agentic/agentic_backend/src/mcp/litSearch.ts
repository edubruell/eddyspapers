import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { computeSearchId } from "../agent/cache.js";
import { runAgent } from "../agent/runAgent.js";
import { buildBundle, collectSynthesis, type SearchBundle } from "../agent/bundle.js";
import { resolveSnapshot } from "../sandbox/snapshot.js";
import { getSearchDb } from "../db/singleton.js";
import type { AgentInput, Stage, StreamEvent } from "../agent/types.js";

// lit_search — the full agentic pipeline over MCP (01_design.md §7.2-§7.5, PLAN.md §C1,
// Phase 3). One brief in, a finished mini-lit-review out: synthesis markdown + BibTeX +
// a flat CSV + the structured paper/section payload. The heavy lifting (script writing,
// R execution, synthesis) runs in the cheap sub-model, not the calling agent's context.
//
// Differences from the web chat face (by design, §7.3):
//   - skip_clarify defaults TRUE — a coding agent already shaped the brief and must never
//     hit a blocking prompt. With skip_clarify=false the tool returns the clarifier's
//     questions as a non-error `needs_clarification` result and stops; the caller re-invokes
//     with a sharper brief. No pause/resume round-trip over MCP, ever.
//   - Identical briefs against the same snapshot hit the persisted cache (§7.8): a completed
//     run is rebuilt from its stored events without re-running R or the synthesiser.

const STAGE_STEP: Record<Stage, number> = {
  clarify: 1,
  write: 2,
  validate: 3,
  execute: 4,
  synthesize: 5,
};

const STAGE_LABEL: Record<Stage, string> = {
  clarify: "Reading the brief",
  write: "Writing the search script",
  validate: "Validating the script",
  execute: "Running the search",
  synthesize: "Writing the synthesis",
};

// Re-emit internal StreamEvents as MCP progress notifications (§7.4) so the calling agent
// sees a live status line instead of a ~30s silent wait. Synthesis token deltas are NOT
// forwarded (they would flood) — the synthesis is delivered whole in the final result.
// A no-op when the client did not attach a progressToken to the call. Typed structurally
// (a subset of the SDK's RequestHandlerExtra) so it stays decoupled from the transport.
interface ProgressCapable {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total: number; message: string };
  }) => Promise<void>;
}

function progressForwarder(extra: ProgressCapable): (e: StreamEvent) => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let step = 0;

  const send = (progress: number, message: string): void => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 5, message },
      })
      .catch(() => undefined);
  };

  return (e: StreamEvent): void => {
    switch (e.type) {
      case "stage":
        if (e.state !== "enter") return;
        step = STAGE_STEP[e.stage];
        send(step, `${STAGE_LABEL[e.stage]}…`);
        return;
      case "strategy":
        send(step, `Strategy: ${e.strategy.slice(0, 200)}`);
        return;
      case "validate":
        if (!e.ok) send(step, "Script rejected — retrying");
        return;
      case "revise":
        send(step, `Refining (${e.mode}): ${e.reason}`);
        return;
      case "section":
        send(step, `Section ready: ${e.section.title} (${e.section.n_shown} papers)`);
        return;
      case "progress":
        send(step, e.label);
        return;
      case "error":
        send(step, `Error: ${e.message}`);
        return;
      default:
        return;
    }
  };
}

function litResult(bundle: SearchBundle): CallToolResult {
  const hasPersons = Object.keys(bundle.persons).length > 0;
  return {
    content: [{ type: "text", text: bundle.synthesis_md || "_No synthesis was produced._" }],
    structuredContent: {
      synthesis_md: bundle.synthesis_md,
      bibtex: bundle.bibtex,
      papers_csv: bundle.papers_csv,
      papers: bundle.papers,
      ...(hasPersons ? { persons: bundle.persons } : {}),
      sections: bundle.sections,
      strategy: bundle.strategy,
      search_id: bundle.search_id,
      script: bundle.script,
      resource_uri: bundle.resource_uri,
      suggested_paths: bundle.suggested_paths,
    },
  };
}

function needsClarificationResult(searchId: string, question: string, options: string[]): CallToolResult {
  const optText = options.length ? `\nOptions: ${options.join(" · ")}` : "";
  return {
    content: [
      {
        type: "text",
        text: `This brief is ambiguous — re-invoke lit_search with a sharper brief that answers:\n${question}${optText}`,
      },
    ],
    structuredContent: {
      needs_clarification: { question, options },
      search_id: searchId,
    },
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerLitSearch(server: McpServer): void {
  server.registerTool(
    "lit_search",
    {
      title: "Agentic literature search",
      description:
        "The full literature-search pipeline: give a natural-language brief and get back a finished " +
        "mini-review — a synthesis, a deduped BibTeX bundle, a flat CSV, and the structured paper/section " +
        "data — from ONE call. It writes and runs a tailored search script (semantic + keyword + journal/" +
        "author scans) against the corpus, so you don't chain find_papers/keyword_search yourself. Use it " +
        "when you want a synthesised answer, not raw rows; use the cheap tools (find_papers, keyword_search, " +
        "find_people) for surgical lookups. Costs ~30s and model tokens. skip_clarify defaults true (no " +
        "blocking questions); set it false to have an ambiguous brief return clarifying questions instead of " +
        "a review. Identical briefs are cached. Write the brief as prose describing the mechanism, method, " +
        "and scope you care about.",
      inputSchema: {
        brief: z.string().min(1).max(2000).describe("Natural-language description of what to find"),
        categories: z
          .array(z.string())
          .optional()
          .describe("Restrict to journal categories (see corpus_context for valid values)"),
        min_year: z.number().int().optional().describe("Earliest publication year to include"),
        must_include: z
          .array(z.string())
          .optional()
          .describe("Authors or handles that must appear if present in the corpus"),
        refine: z
          .boolean()
          .optional()
          .describe("Allow one results-aware refine pass after the first round (default false)"),
        skip_clarify: z
          .boolean()
          .optional()
          .describe("Skip blocking clarification (default true for MCP)"),
      },
    },
    async (a, extra): Promise<CallToolResult> => {
      try {
        const snapshot = await resolveSnapshot();
        const dbSnapshotDate =
          snapshot.exists && snapshot.ageMs != null
            ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
            : "unknown";

        const searchId = computeSearchId({
          brief: a.brief,
          categories: a.categories,
          minYear: a.min_year,
          dbSnapshotDate,
        });
        const db = await getSearchDb();

        // Cache hit (§7.8): a completed run is rebuilt from its stored events — no R, no LLM.
        const existing = await db.getSearch(searchId);
        if (existing?.status === "done") {
          return litResult(buildBundle(searchId, a.brief, existing.events));
        }

        const input: AgentInput = {
          brief: a.brief,
          categories: a.categories,
          minYear: a.min_year,
          mustInclude: a.must_include,
          refine: a.refine,
          skipClarify: a.skip_clarify ?? true,
        };
        await db.upsertSearch(searchId, { ...input, dbSnapshotDate });

        const events: StreamEvent[] = [];
        const forward = progressForwarder(extra);
        const result = await runAgent(searchId, input, snapshot.path, (e) => {
          events.push(e);
          forward(e);
        });
        await db.appendEvents(searchId, events);

        // skip_clarify=false and the clarifier asked → surface the questions as a non-error
        // structured result (§7.3). The run is left awaiting_clarification in the store, but
        // MCP has no resume path — the caller re-invokes lit_search with a sharper brief.
        if (result.paused) {
          const clar = events.find((e) => e.type === "clarify");
          const question = clar && "question" in clar ? clar.question : "";
          const options = clar && "options" in clar ? clar.options : [];
          await db.setAwaitingClarification(searchId, question);
          return needsClarificationResult(searchId, question, options);
        }

        // Only a run that emitted a terminal `done` is finalized (and cached) as done —
        // mirrors the web /chat path (chat.ts) so a truncated run that returned without a
        // done/error is never persisted as a complete, cache-servable result.
        const errored = events.find((e) => e.type === "error" && !e.recoverable);
        const hasDone = events.some((e) => e.type === "done");
        const synthesis = collectSynthesis(events);
        const status = !errored && hasDone ? "done" : "error";
        await db.finalizeSearch(searchId, status, synthesis);
        if (status === "error") {
          const message = errored && "message" in errored ? errored.message : "Search ended without a result.";
          return fail(`Search failed: ${message}`);
        }
        return litResult(buildBundle(searchId, a.brief, events));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
