import { Hono } from "hono";
import { env } from "../env.js";
import { getSearchDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";

export const statsRoute = new Hono();

// Admin telemetry for the operator's R poller (mirrors the semantic-search
// /stats/searches contract: ?days=N window, aggregate totals). Usage data is
// not public, so both routes need an 'admin'-scoped key — the grandfathered shared
// password carries every scope, so the existing poller keeps working.
statsRoute.get("/searches", requireKey("admin"), async (c) => {
  const days = Number(c.req.query("days") ?? "30");
  if (!Number.isInteger(days) || days <= 0) {
    return c.json({ error: "days must be a positive integer" }, 400);
  }
  const db = await getSearchDb();
  return c.json(await db.getStats(days));
});

statsRoute.get("/dailylogs", requireKey("admin"), async (c) => {
  const day = c.req.query("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return c.json({ error: "day=YYYY-MM-DD required" }, 400);
  }
  const db = await getSearchDb();
  return c.json(await db.getDailyLogs(day));
});

// Proxies the shared semantic-search API so the browser can show the DB snapshot
// date without ever handling the API key. Plumber wraps scalars in arrays
// ({"last_updated":["2026-06-05"]}); we unwrap to a plain string for the frontend.
statsRoute.get("/last_updated", async (c) => {
  if (!env.EDDYPAPERS_API_KEY) {
    return c.json({ last_updated: null }, 200);
  }
  try {
    const res = await fetch(`${env.SEMANTIC_API_BASE}/stats/last_updated`, {
      headers: { "X-API-Key": env.EDDYPAPERS_API_KEY },
    });
    if (!res.ok) {
      return c.json({ last_updated: null }, 200);
    }
    const data = (await res.json()) as { last_updated?: string | string[] };
    const value = Array.isArray(data.last_updated)
      ? (data.last_updated[0] ?? null)
      : (data.last_updated ?? null);
    return c.json({ last_updated: value }, 200);
  } catch {
    return c.json({ last_updated: null }, 200);
  }
});
