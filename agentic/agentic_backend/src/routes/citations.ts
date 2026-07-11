import { Hono } from "hono";
import { getCorpusDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import {
  citingPapersOf,
  citedPapersOf,
  versionLinksOf,
  citationCountsOf,
  handleStatsOf,
} from "../search/citations.js";

// Citation / version / handle-stats routes ported from Plumber (PLAN.md §A2). These are
// top-level paths (/versions, /cites, …) so the route mounts at "/". Query param `handle`
// is required; `limit` defaults to 50 like Plumber.

export const citationsRoute = new Hono();

const limitOf = (raw: string | undefined): number => {
  const n = Number(raw ?? "50");
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 50;
};

const requireHandle = (c: { req: { query(k: string): string | undefined } }): string | null => {
  const h = c.req.query("handle");
  return h && h.length > 0 ? h : null;
};

citationsRoute.get("/versions", requireKey("rest"), async (c) => {
  const handle = requireHandle(c);
  if (!handle) return c.json({ error: "handle required" }, 400);
  const db = await getCorpusDb();
  return c.json(await versionLinksOf(db, handle));
});

citationsRoute.get("/cites", requireKey("rest"), async (c) => {
  const handle = requireHandle(c);
  if (!handle) return c.json({ error: "handle required" }, 400);
  const db = await getCorpusDb();
  return c.json(await citedPapersOf(db, handle, limitOf(c.req.query("limit"))));
});

citationsRoute.get("/citedby", requireKey("rest"), async (c) => {
  const handle = requireHandle(c);
  if (!handle) return c.json({ error: "handle required" }, 400);
  const db = await getCorpusDb();
  return c.json(await citingPapersOf(db, handle, limitOf(c.req.query("limit"))));
});

citationsRoute.get("/citationcounts", requireKey("rest"), async (c) => {
  const handle = requireHandle(c);
  if (!handle) return c.json({ error: "handle required" }, 400);
  const db = await getCorpusDb();
  return c.json(await citationCountsOf(db, handle));
});

// /handlestats is the one route the classic frontend hard-depends on being *boxed*: its
// getHandleStats() gates on `Array.isArray(data.handle)` and reads the JSON-string columns
// with its own JSON.parse. So mirror Plumber's auto_unbox=FALSE list serialisation — wrap
// every value in a one-element array (BigInt → Number so JSON.stringify survives) and leave
// citations_by_year / citer_category_* as raw strings. Not-found is a 200 body, matching
// Plumber (the handler never sets a 404 status).
const jsonScalar = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);
const boxRow = (row: Record<string, unknown>): Record<string, unknown[]> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, [jsonScalar(v)]]));

citationsRoute.get("/handlestats", requireKey("rest"), async (c) => {
  const handle = requireHandle(c);
  if (!handle) return c.json({ error: "handle required" }, 400);
  const db = await getCorpusDb();
  const row = await handleStatsOf(db, handle);
  if (!row) return c.json({ error: ["Handle not found in statistics table"] });
  return c.json(boxRow(row));
});
