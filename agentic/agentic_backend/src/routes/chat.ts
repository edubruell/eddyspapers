import { Hono } from "hono";
import { z } from "zod";
import { resolveSnapshot } from "../sandbox/snapshot.js";
import { computeSearchId } from "../agent/cache.js";
import { runAgent } from "../agent/runAgent.js";
import { bus } from "../stream/bus.js";
import { getSearchDb } from "../db/singleton.js";

const chatBodySchema = z.object({
  brief: z.string().min(1).max(2000),
  categories: z.array(z.string()).optional(),
  minYear: z.number().int().optional(),
  mustInclude: z.array(z.string()).optional(),
});

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
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

  const { brief, categories, minYear, mustInclude } = parsed.data;
  const snapshot = await resolveSnapshot();

  const dbSnapshotDate = snapshot.exists && snapshot.ageMs != null
    ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
    : "unknown";

  const id = computeSearchId({ brief, categories, minYear, dbSnapshotDate });
  const db = await getSearchDb();

  const existing = await db.getSearch(id);
  if (existing?.status === "done") {
    return c.json({ id }, 200);
  }

  await db.upsertSearch(id, { brief, categories, minYear, mustInclude, dbSnapshotDate });

  const input = { brief, categories, minYear, mustInclude };
  const dbPath = snapshot.path;

  // Fire and forget — client subscribes via SSE
  const buffered: Parameters<typeof bus.publish>[1][] = [];
  runAgent(id, input, dbPath, (e) => {
    bus.publish(id, e);
    buffered.push(e);
  })
    .then(async () => {
      const synthesis = buffered
        .filter((e) => e.type === "synthesis")
        .map((e) => ("delta" in e ? e.delta : ""))
        .join("");
      const hasDone = buffered.some((e) => e.type === "done");
      const hasError = buffered.some((e) => e.type === "error" && !e.recoverable);
      const status = hasError ? "error" : hasDone ? "done" : "error";
      await db.appendEvents(id, buffered);
      await db.finalizeSearch(id, status, synthesis);
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runAgent] uncaught error for ${id}: ${message}`);
      await db.appendEvents(id, buffered).catch(() => undefined);
      await db.finalizeSearch(id, "error", "").catch(() => undefined);
    });

  return c.json({ id }, 201);
});
