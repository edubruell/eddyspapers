import { Hono } from "hono";
import { z } from "zod";
import { resolveSnapshot } from "../sandbox/snapshot.js";
import { computeSearchId } from "../agent/cache.js";
import { runAgent, type RunOpts } from "../agent/runAgent.js";
import { bus } from "../stream/bus.js";
import { getSearchDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import type { SearchDb } from "../db/searches.js";
import type { AgentInput, StreamEvent } from "../agent/types.js";

const chatBodySchema = z.object({
  brief: z.string().min(1).max(2000),
  skipClarify: z.boolean().optional(),
  refine: z.boolean().optional(),
  categories: z.array(z.string()).optional(),
  minYear: z.number().int().optional(),
  mustInclude: z.array(z.string()).optional(),
});

const replyBodySchema = z.object({
  answer: z.string().min(1).max(2000),
});

export const chatRoute = new Hono();

// Once a run reaches a terminal state, its buffered events on the bus are no longer needed
// for the live stream (late viewers read the persisted copy via GET /searches/:id). Drop
// them after a grace period so in-flight streams drain first; guard on isDone so a stale
// timer from a since-retried run can't wipe an active entry. unref so it never holds the
// process open.
const BUS_CLEANUP_GRACE_MS = 60_000;
function scheduleBusCleanup(id: string): void {
  const t = setTimeout(() => {
    if (bus.isDone(id)) bus.cleanup(id);
  }, BUS_CLEANUP_GRACE_MS);
  t.unref?.();
}

// Drives one pass of runAgent (Phase A start or Phase B resume): mirrors events onto
// the live bus, buffers them, then persists — either suspending on a clarifier pause or
// finalizing the run. Fire-and-forget; the client follows the SSE stream.
function runPhase(db: SearchDb, id: string, input: AgentInput, dbPath: string, opts: RunOpts): void {
  const buffered: StreamEvent[] = [];
  runAgent(
    id,
    input,
    dbPath,
    (e) => {
      bus.publish(id, e);
      buffered.push(e);
    },
    opts,
  )
    .then(async (result) => {
      await db.appendEvents(id, buffered);
      if (result.paused) {
        const clar = buffered.find((e) => e.type === "clarify");
        await db.setAwaitingClarification(id, clar && "question" in clar ? clar.question : "");
        return;
      }
      const synthesis = buffered
        .filter((e) => e.type === "synthesis")
        .map((e) => ("delta" in e ? e.delta : ""))
        .join("");
      const hasDone = buffered.some((e) => e.type === "done");
      const hasError = buffered.some((e) => e.type === "error" && !e.recoverable);
      const status = hasError ? "error" : hasDone ? "done" : "error";
      await db.finalizeSearch(id, status, synthesis);
      scheduleBusCleanup(id);
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runAgent] uncaught error for ${id}: ${message}`);
      await db.appendEvents(id, buffered).catch(() => undefined);
      await db.finalizeSearch(id, "error", "").catch(() => undefined);
      scheduleBusCleanup(id);
    });
}

// requireKey('rest') is bound to each POST route (not a `/chat/*` wildcard) so it gates only
// the costly LLM calls. The SSE stream — a separate sub-app mounted on the same /chat prefix —
// stays open, since EventSource can't carry an Authorization header.
chatRoute.post("/", requireKey("rest"), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const { brief, skipClarify, refine, categories, minYear, mustInclude } = parsed.data;
  const snapshot = await resolveSnapshot();

  const dbSnapshotDate = snapshot.exists && snapshot.ageMs != null
    ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
    : "unknown";

  const id = computeSearchId({ brief, categories, minYear, mustInclude, refine, dbSnapshotDate });
  const db = await getSearchDb();

  const existing = await db.getSearch(id);
  if (existing?.status === "done") {
    return c.json({ id }, 200);
  }

  // Atomic claim: only the caller that inserts the row (or reclaims a previously errored
  // one) launches runAgent. A concurrent identical brief — or a re-POST of a still-running
  // or awaiting-clarification run — gets `claimed === false` and just attaches to the live
  // stream, so two runners never publish to one bus with colliding seqs.
  const claimed = await db.claimSearch(id, { brief, categories, minYear, mustInclude, refine, dbSnapshotDate });
  if (!claimed) {
    return c.json({ id }, 202);
  }

  // Fresh start: drop any stale bus entry left by a prior errored attempt of this id.
  bus.cleanup(id);

  const input: AgentInput = { brief, categories, minYear, mustInclude, skipClarify, refine };
  runPhase(db, id, input, snapshot.path, { startSeq: 0, runClarify: true });

  return c.json({ id }, 201);
});

// Phase B — the human-in-the-loop reply to a blocking clarifier question. Validates the
// run is paused, records the answer, and resumes write → … → done on the same bus.
chatRoute.post("/:id/reply", requireKey("rest"), async (c) => {
  const id = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = replyBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }
  const answer = parsed.data.answer.trim();
  if (!answer) {
    return c.json({ error: "Answer must not be empty" }, 400);
  }

  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) {
    return c.json({ error: "Search not found" }, 404);
  }
  if (search.status !== "awaiting_clarification") {
    return c.json({ error: "Search is not awaiting clarification" }, 409);
  }

  // Atomic claim — guards against two concurrent replies both passing the check above.
  const claimed = await db.recordClarifyAnswer(id, answer);
  if (!claimed) {
    return c.json({ error: "Search is not awaiting clarification" }, 409);
  }

  const snapshot = await resolveSnapshot();
  const startSeq = search.events.length ? search.events[search.events.length - 1].seq + 1 : 0;

  const input: AgentInput = {
    brief: search.brief,
    categories: search.categories ?? undefined,
    minYear: search.minYear ?? undefined,
    refine: search.refine,
    clarifyQuestion: search.clarifyQuestion ?? undefined,
    clarifyAnswer: answer,
  };
  runPhase(db, id, input, snapshot.path, { startSeq, runClarify: false });

  return c.json({ ok: true }, 200);
});
