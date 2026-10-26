import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { computeSearchId } from "../agent/cache.js";
import { runAgent } from "../agent/runAgent.js";
import { buildBundle, collectSynthesis, resultsDigest, whereTheRestIs, type Delivery, type SearchBundle } from "../agent/bundle.js";
import { loadRun } from "../agent/loadRun.js";
import { ownsRun, recordRunOwner } from "../agent/ownership.js";
import { PART_DOCS, SEARCH_PARTS, searchPart, sectionSummaries, type SearchPart } from "../agent/parts.js";
import { resolveSnapshot } from "../sandbox/snapshot.js";
import { getSearchDb } from "../db/singleton.js";
import { getRateLimiter } from "../auth/rateLimit.js";
import type { KeyIdentity } from "../auth/keys.js";
import type { AgentInput, Stage, StreamEvent } from "../agent/types.js";
import { liveRun, liveRunOf, startRun, waitFor, waitMs, type LiveRun, type RunOutcome } from "./litRuns.js";
import { bus } from "../stream/bus.js";

// lit_search — the agentic search pipeline over MCP (01_design.md §7.2-§7.5, PLAN.md §C1,
// Phase 3). One brief in; the server writes a tailored R search script, runs it against the
// corpus, and hands back the script, the deduped BibTeX, a flat CSV, and the structured
// paper/section payload. None of that retrieval work lands in the calling agent's context.
//
// Two modes, and the DEFAULT is script-only:
//   - script-only (synthesize=false, default) — retrieval and nothing else. The caller gets
//     the rows and writes its own review, on its own budget. Costs one cheap script-writing
//     call; no synthesis tokens are spent on this server's account.
//   - synthesis (synthesize=true) — the server additionally writes the mini-review. This is
//     the expensive stage, so it is gated on the separate 'lit_search_synth' key scope; a key
//     without that scope asking for it gets a plain refusal, never a silent downgrade.
//
// Differences from the web chat face (by design, §7.3):
//   - skip_clarify defaults TRUE — a coding agent already shaped the brief and must never
//     hit a blocking prompt. With skip_clarify=false the tool returns the clarifier's
//     questions as a non-error `needs_clarification` result and stops; the caller re-invokes
//     with a sharper brief. No pause/resume round-trip over MCP, ever.
//   - Identical briefs against the same snapshot hit the persisted cache (§7.8): a completed
//     run is rebuilt from its stored events without re-running R or the synthesiser.
//   - Delivery is size-aware: a big run comes back as a handle (digest + search_id) rather
//     than a ~130k-char inline payload, and fetch_search serves the parts. The cache key
//     deliberately does NOT include `deliver` — how a run is delivered is a presentation
//     choice, so the same cached run can be handed back either way.

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

function progressForwarder(extra: ProgressCapable, totalSteps: number): (e: StreamEvent) => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let step = 0;

  const send = (progress: number, message: string): void => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: totalSteps, message },
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

// Handle delivery kicks in above this many characters of inlined artifacts. Sized so an
// ordinary 10-20 paper run still arrives in one piece while a big sweep — measured at
// 133,641 chars for 40 papers, which overflowed a real client's per-result cap — comes back
// as a handle the caller pulls from.
type DeliverMode = "auto" | "inline" | "handle";

const INLINE_BUDGET = 60_000;

function litResult(bundle: SearchBundle, deliver: DeliverMode): CallToolResult {
  const hasPersons = Object.keys(bundle.persons).length > 0;
  // A run stored without synthesis is a script-only run — including a cache hit replayed from
  // the store, so the mode is read off the bundle rather than the request.
  const synthesized = bundle.synthesis_md.trim().length > 0;

  const artifacts = {
    bibtex: bundle.bibtex,
    papers_csv: bundle.papers_csv,
    papers: bundle.papers,
    ...(hasPersons ? { persons: bundle.persons } : {}),
    sections: bundle.sections,
    script: bundle.script,
  };
  // 'auto' measures rather than guesses: the same brief can return 3 papers or 300.
  const delivery: Delivery =
    deliver === "inline" ? "inline"
    : deliver === "handle" ? "handle"
    : JSON.stringify(artifacts).length <= INLINE_BUDGET ? "inline"
    : "handle";

  const common = {
    mode: synthesized ? "synthesis" : "script_only",
    delivery,
    synthesis_md: bundle.synthesis_md,
    strategy: bundle.strategy,
    search_id: bundle.search_id,
    resource_uri: bundle.resource_uri,
    slug: bundle.slug,
  };

  const text = synthesized ? bundle.synthesis_md : resultsDigest(bundle, delivery);
  if (delivery === "inline") {
    return { content: [{ type: "text", text }], structuredContent: { ...common, ...artifacts } };
  }

  // Handle delivery: everything the caller needs to CITE is already in the text digest;
  // what is withheld is the bulk (abstracts, CSV, .bib, the script), reachable by one
  // fetch_search call each. The synthesis is never withheld — it is the deliverable, and it
  // is the only text block that needs the where-to-fetch footer bolted on (the digest
  // already carries that sentence in its own header).
  return {
    content: [
      { type: "text", text: synthesized ? `${text}\n\n---\n${whereTheRestIs(bundle, "handle")}` : text },
    ],
    structuredContent: {
      ...common,
      n_papers: Object.keys(bundle.papers).length,
      n_persons: Object.keys(bundle.persons).length,
      sections: sectionSummaries(bundle.sections),
      fetch: {
        tool: "fetch_search",
        search_id: bundle.search_id,
        parts: PART_DOCS,
      },
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

// A refusal (missing scope, rate limit) is the caller's to fix, not a server fault. The
// _meta flag lets the MCP call log count it apart from tool errors (db/mcpLog.ts).
export function refuse(message: string, reason: "scope" | "rate_limit"): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true, _meta: { refused: reason } };
}

function runningResult(searchId: string, startedAt: number): CallToolResult {
  const retryAfterSec = 60;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  return {
    content: [
      {
        type: "text",
        text:
          `The search is still running (started ${elapsedSec}s ago; most runs take 1-3 minutes, a refine ` +
          `pass longer). In about ${retryAfterSec} seconds, call lit_search again with exactly the same ` +
          `arguments: that joins this search (search_id '${searchId}') rather than starting a new one, ` +
          `costs no quota, and returns the results once it is done. Do not change the brief meanwhile; ` +
          `a different brief is refused until this one finishes.`,
      },
    ],
    structuredContent: { status: "running", search_id: searchId, elapsed_sec: elapsedSec, retry_after_sec: retryAfterSec },
  };
}

const failedMessage = (events: StreamEvent[]): string => {
  const errored = events.find((e) => e.type === "error" && !e.recoverable);
  return errored && "message" in errored ? errored.message : "Search ended without a result.";
};

// Runs the pipeline and records the result in the store. Mirrors the web /chat path: only a
// run that emitted a terminal `done` without a fatal error is finalized (and cached) as done.
async function executeRun(
  searchId: string,
  input: AgentInput,
  snapshotPath: string,
  onEvent: (e: StreamEvent) => void,
): Promise<RunOutcome> {
  const db = await getSearchDb();
  const events: StreamEvent[] = [];
  // A throw would otherwise leave the row 'running', which fetch_search reads as a restart.
  const result = await runAgent(searchId, input, snapshotPath, (e) => {
    events.push(e);
    onEvent(e);
  }).catch(async (err: unknown) => {
    await db.appendEvents(searchId, events).catch(() => undefined);
    await db.finalizeSearch(searchId, "error", "").catch(() => undefined);
    throw err;
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
    return { kind: "clarify", question, options };
  }

  const done = !events.some((e) => e.type === "error" && !e.recoverable) && events.some((e) => e.type === "done");
  await db.finalizeSearch(searchId, done ? "done" : "error", collectSynthesis(events));
  return done ? { kind: "done", events } : { kind: "failed", message: failedMessage(events) };
}

function outcomeResult(searchId: string, brief: string, outcome: RunOutcome, deliver: DeliverMode): CallToolResult {
  switch (outcome.kind) {
    case "done":
      return litResult(buildBundle(searchId, brief, outcome.events), deliver);
    case "clarify":
      return needsClarificationResult(searchId, outcome.question, outcome.options);
    case "failed":
      return fail(`Search failed: ${outcome.message}`);
  }
}

export function registerLitSearch(server: McpServer, key: KeyIdentity | null = null): void {
  registerFetchSearch(server, key);
  server.registerTool(
    "lit_search",
    {
      title: "Agentic literature search",
      description:
        "Run a whole literature search server-side from ONE natural-language brief. The server writes a " +
        "tailored R search script (semantic + keyword + journal/author scans), runs it against the corpus, " +
        "and returns the retrieved papers, a deduped BibTeX bundle, a flat CSV, the section structure, and " +
        "the script itself — so you don't chain find_papers/keyword_search yourself and the retrieval never " +
        "enters your context. Takes 1-3 minutes; refine=true can take several more.\n\n" +
        "LONG RUNS. The call waits about 40 seconds. A run that is not done by then comes back with " +
        "status='running' and its search_id. Call lit_search again with exactly the same arguments after " +
        "retry_after_sec: it joins the running search (no second run, no quota) and returns the results " +
        "once done. A different brief is refused while one of your searches is running.\n\n" +
        "MODES. By default (synthesize=false) this returns RESULTS ONLY: you get the rows and write the " +
        "review yourself. Set synthesize=true to have the server write the mini-review as well — that is " +
        "the expensive stage and it requires an API key granted the 'lit_search_synth' scope; without it " +
        "the call is refused rather than silently downgraded, so don't retry it, just work from the rows.\n\n" +
        "DELIVERY. Large runs are NOT inlined: above a size budget the tool returns the citable " +
        "digest plus a search_id, and you pull the BibTeX, CSV, full records or script with " +
        "fetch_search (structuredContent.delivery tells you which happened). The digest always " +
        "lists every retrieved paper, so you can write the review without fetching anything.\n\n" +
        "Use lit_search when you want a whole literature swept; use the cheap tools (find_papers, " +
        "keyword_search, find_people) for surgical lookups. skip_clarify defaults true (never blocks); set " +
        "it false to have an ambiguous brief come back as clarifying questions instead of results. " +
        "Identical briefs are cached. Write the brief as prose describing the mechanism, method, and scope " +
        "you care about — not keyword labels.",
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
        synthesize: z
          .boolean()
          .optional()
          .describe(
            "Have the server WRITE the literature review over the results (default false). " +
              "Requires a key with the 'lit_search_synth' scope; leave it false and write the review " +
              "yourself from the returned papers.",
          ),
        deliver: z
          .enum(["auto", "inline", "handle"])
          .optional()
          .describe(
            "How to return the artifacts. 'auto' (default) inlines everything for a small run and " +
              "switches to a handle for a large one; 'inline' always returns the full BibTeX, CSV, " +
              "paper records and script in structuredContent (can be >100k chars); 'handle' always " +
              "returns the citable digest plus a search_id you pull the artifacts from with " +
              "fetch_search. The digest lists every retrieved paper either way.",
          ),
      },
    },
    async (a, extra): Promise<CallToolResult> => {
      try {
        const snapshot = await resolveSnapshot();
        const dbSnapshotDate =
          snapshot.exists && snapshot.ageMs != null
            ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
            : "unknown";

        const deliver: DeliverMode = a.deliver ?? "auto";

        const input: AgentInput = {
          brief: a.brief,
          categories: a.categories,
          minYear: a.min_year,
          mustInclude: a.must_include,
          refine: a.refine,
          skipClarify: a.skip_clarify ?? true,
          synthesize: a.synthesize ?? false,
        };

        const searchId = computeSearchId({ ...input, dbSnapshotDate });

        // Enforce the finer 'lit_search' scope up front — before even the cache lookup —
        // so a key that lacks it can't read back another caller's completed run (the cache
        // is keyed on brief+snapshot, not on key). A null key means the gate is disabled
        // (dev / local stdio) — no scope check, no limiting.
        if (key && !key.scopes.includes("lit_search")) {
          return refuse("This API key lacks the 'lit_search' scope.", "scope");
        }
        // Server-side synthesis is the one stage billed to this server, so it carries its own
        // grant. Refuse rather than downgrade: a caller that silently got no review would
        // report the tool as broken instead of writing the review itself.
        if (input.synthesize && key && !key.scopes.includes("lit_search_synth")) {
          return refuse(
            "Server-side synthesis is off by default and this API key lacks the 'lit_search_synth' " +
              "scope. Re-invoke with synthesize=false to get the papers, BibTeX, CSV and script, and " +
              "write the review yourself.",
            "scope",
          );
        }

        const db = await getSearchDb();

        // Cache hit (§7.8): a completed run is rebuilt from its stored events — no R, no LLM,
        // and no rate-limit quota consumed (a repeat is free). Scope is already enforced above.
        const existing = await db.getSearch(searchId);
        if (existing?.status === "done") {
          // A cache hit is this caller's own search — they supplied the exact inputs the run
          // was keyed on — so they join it as an owner and can fetch_search it afterwards.
          await recordRunOwner(searchId, key);
          return litResult(buildBundle(searchId, a.brief, existing.events), deliver);
        }

        // The same brief already running for this server (a client retrying after its own
        // timeout): join that run instead of starting or refusing a second one. The caller
        // supplied the exact inputs the run was keyed on, so it becomes an owner too.
        const join = async (live: LiveRun): Promise<CallToolResult> => {
          const outcome = await waitFor(live, waitMs());
          return outcome ? outcomeResult(searchId, a.brief, outcome, deliver) : runningResult(searchId, live.startedAt);
        };
        const joined = liveRun(searchId);
        if (joined) {
          await recordRunOwner(searchId, key);
          return join(joined);
        }

        // The web /chat face runs the same ids on its own bus; resetting its row here would
        // wipe a live run (or a pending clarifier reply), so leave it to finish and cache.
        if (bus.isLive(searchId)) {
          return fail(
            "This exact search is already running in the web app. Call lit_search again with the same " +
              "arguments in about a minute to get its results.",
          );
        }

        // A real run costs model tokens: apply the per-key rate limit + single-concurrent
        // cap (PLAN.md §D1). Cache hits and joins skip this — neither starts a run.
        const limiter = getRateLimiter();
        const gate = key ? limiter.tryAcquire(key.id, "lit_search", key.rateLimitOverrides) : ({ ok: true } as const);
        if (!gate.ok) {
          const busyWith = key ? liveRunOf(key.id) : undefined;
          return refuse(
            busyWith
              ? `${gate.reason} Your search '${busyWith}' is still running. Collect it first by calling ` +
                  `lit_search again with that search's exact arguments, then start this one.`
              : `${gate.reason} Retry in ${gate.retryAfterSec} seconds.`,
            "rate_limit",
          );
        }

        const release = (): void => {
          if (key) limiter.release(key.id, "lit_search");
        };
        try {
          await db.restartSearch(searchId, { ...input, dbSnapshotDate });
          await recordRunOwner(searchId, key);
        } catch (err) {
          release();
          throw err;
        }

        // A concurrent identical call (another key, or the ungated null key) may have started
        // the run during the awaits above; join it rather than launch a second runner.
        const raced = liveRun(searchId);
        if (raced) {
          release();
          return join(raced);
        }

        // Progress goes to this call only while it waits; once it hands back the search_id
        // the transport is closed and the run carries on unobserved.
        const forward = progressForwarder(extra, input.synthesize ? 5 : 4);
        const attached = { now: true };
        const run = startRun(searchId, key?.id ?? null, () =>
          executeRun(searchId, input, snapshot.path, (e) => attached.now && forward(e)).finally(release),
        );
        const outcome = await waitFor(run, waitMs());
        attached.now = false;
        return outcome ? outcomeResult(searchId, a.brief, outcome, deliver) : runningResult(searchId, run.startedAt);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// fetch_search — the other half of handle delivery. A completed run stays readable by id, so
// a caller that got a handle (or one that wants the .bib from a run it made an hour ago)
// pulls exactly the part it needs, paginated. The same cuts exist as agenticsearch://searches
// resources; this tool exists because plenty of MCP clients expose tools but not resources.
//
// It reads back stored run content, so it rides the same 'lit_search' scope as the tool that
// produced it. No rate limit: serving a stored artifact costs nothing.
export function registerFetchSearch(server: McpServer, key: KeyIdentity | null = null): void {
  const partList = SEARCH_PARTS.map((p) => `'${p}' — ${PART_DOCS[p]}`).join(" ");

  server.registerTool(
    "fetch_search",
    {
      title: "Fetch part of a completed lit_search run",
      description:
        "Read one artifact of a completed lit_search run by its search_id. Use this when lit_search " +
        "returned delivery='handle' (the artifacts were too large to inline), or to re-read a run you " +
        "made earlier — your own runs stay readable, no re-search and no tokens spent. Fetch only what you " +
        "need: the BibTeX to write a .bib, the CSV or papers to inspect abstracts, the script to see " +
        "how the search was built. 'papers' and 'csv' carry abstracts and are paginated — walk them " +
        "with next_offset. Start with 'overview' if you don't know what the run contains. For a run " +
        "lit_search returned as status='running', this call waits up to about 40 seconds for it; if it " +
        "is still not done you get status='running' again, so call once more after retry_after_sec.",
      inputSchema: {
        search_id: z.string().min(4).describe("The search_id returned by lit_search"),
        part: z.enum(SEARCH_PARTS).describe(`Which artifact to read. ${partList}`),
        section_id: z.string().optional().describe("With part='sections', return only this section"),
        offset: z.number().int().min(0).optional().describe("Row offset for 'papers'/'csv' (default 0)"),
        limit: z.number().int().min(1).max(500).optional().describe("Rows per page for 'papers'/'csv' (default 25)"),
      },
    },
    async (a): Promise<CallToolResult> => {
      try {
        if (key && !key.scopes.includes("lit_search")) {
          return refuse("This API key lacks the 'lit_search' scope.", "scope");
        }
        // Ownership (S6): a stored run is readable only by the key that made it. The
        // not-found and not-yours answers are deliberately the SAME message — distinguishing
        // them would turn this tool into an oracle for which run ids exist.
        const notFound = fail(`No stored search with id '${a.search_id}' readable by this key. Run lit_search first.`);
        if (!(await ownsRun(a.search_id, key))) return notFound;

        // A run lit_search handed back as still running: wait for it here, so the caller
        // polls at most every waitMs() instead of spinning.
        const live = liveRun(a.search_id);
        if (live && (await waitFor(live, waitMs())) === null) return runningResult(a.search_id, live.startedAt);

        const run = await loadRun(a.search_id);
        if (!run) return notFound;
        switch (run.search.status) {
          case "running":
            return fail(
              "This search was interrupted before it finished, most likely by a server restart. " +
                "Call lit_search again with the same brief to rerun it.",
            );
          case "error":
            return fail(`Search failed: ${failedMessage(run.search.events)}`);
          case "awaiting_clarification":
            return fail(
              `This search stopped to ask a clarifying question: ${run.search.clarifyQuestion ?? ""} ` +
                "Call lit_search again with a sharper brief.",
            );
          case "done":
            break;
        }

        const { text, data } = searchPart(run.bundle, a.part as SearchPart, {
          offset: a.offset,
          limit: a.limit,
          sectionId: a.section_id,
        });
        // An empty artifact is a legitimate answer (a script-only run has no synthesis), but an
        // empty text block reads as a broken call — say so instead.
        return {
          content: [{ type: "text", text: text.length > 0 ? text : `(this run has no '${a.part}' content)` }],
          structuredContent: data,
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
