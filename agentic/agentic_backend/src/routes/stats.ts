import { Hono } from "hono";
import { getSearchDb, getCorpusDb, getAppDataDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import { getSearchStats } from "../db/classic.js";

export const statsRoute = new Hono();

// ── Agentic run telemetry (moved under /agentic to free /stats/searches + /dailylogs for
// the classic Plumber ports, PLAN.md §6 decision 1). The operator's R poller authenticates
// with AGENTIC_PASSWORD, which the registry treats as an all-scope legacy identity — so the
// 'admin' scope keeps working across the path move.
statsRoute.get("/agentic/searches", requireKey("admin"), async (c) => {
  const days = Number(c.req.query("days") ?? "30");
  if (!Number.isInteger(days) || days <= 0) {
    return c.json({ error: "days must be a positive integer" }, 400);
  }
  const db = await getSearchDb();
  return c.json(await db.getStats(days));
});

statsRoute.get("/agentic/dailylogs", requireKey("admin"), async (c) => {
  const day = c.req.query("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return c.json({ error: "day=YYYY-MM-DD required" }, 400);
  }
  const db = await getSearchDb();
  return c.json(await db.getDailyLogs(day));
});

// ── Classic search-log stats (ported get_search_stats). Kept at 'rest' rather than 'admin':
// Plumber gated it behind the same single key as /search, and the nginx frontend-key
// injection overwrites X-API-Key with a rest-scoped key — so the operator poller keeps
// working unchanged. No new privilege boundary is introduced (parity with Plumber).
statsRoute.get("/searches", requireKey("rest"), async (c) => {
  const days = Number(c.req.query("days") ?? "30");
  if (!Number.isInteger(days) || days <= 0) {
    return c.json({ error: "days must be a positive integer" }, 400);
  }
  const appdata = await getAppDataDb();
  return c.json(await getSearchStats(appdata, days));
});

// ── Corpus counts (ported get_total_articles / get_journal_stats / get_category_stats).
statsRoute.get("/total", requireKey("rest"), async (c) => {
  const db = await getCorpusDb();
  const [row] = await db.query("SELECT COUNT(*) AS n FROM articles");
  return c.json({ total_articles: Number(row?.n ?? 0) });
});

statsRoute.get("/journals", requireKey("rest"), async (c) => {
  const db = await getCorpusDb();
  const rows = await db.query(
    "SELECT journal, COUNT(*) AS n FROM articles GROUP BY journal ORDER BY journal",
  );
  return c.json(rows.map((r) => ({ journal: r.journal as string | null, n: Number(r.n) })));
});

statsRoute.get("/categories", requireKey("rest"), async (c) => {
  const db = await getCorpusDb();
  const rows = await db.query(
    "SELECT category, COUNT(*) AS n FROM articles GROUP BY category ORDER BY n DESC",
  );
  return c.json(rows.map((r) => ({ category: r.category as string | null, n: Number(r.n) })));
});

// ── Snapshot date, de-proxied (PLAN.md §A2): read db_metadata directly off the corpus
// snapshot instead of round-tripping the old Plumber /stats/last_updated. Unauthenticated —
// the agentic frontend calls it keyless, same-origin. A snapshot missing db_metadata (e.g.
// a slim test fixture) yields null rather than an error.
statsRoute.get("/last_updated", async (c) => {
  const db = await getCorpusDb();
  const rows = await db
    .query("SELECT value FROM db_metadata WHERE key = 'last_content_update'")
    .catch(() => [] as Record<string, unknown>[]);
  const value = rows[0]?.value;
  return c.json({ last_updated: value == null ? null : String(value) });
});
