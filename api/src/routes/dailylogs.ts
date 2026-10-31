import { Hono } from "hono";
import { getAppDataDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import { searchLogsDay } from "../db/classic.js";

// Ported Plumber GET /dailylogs (a TOP-LEVEL route, not under /stats) — raw search_logs
// rows for one day, for the operator's daily-log poller (get_stats_from_api.R). 'admin', not
// 'rest': the rows carry visitor IPs, and nginx injects a rest key on every classic and
// EconPeople /api/ request, so a rest gate here is public.
export const dailyLogsRoute = new Hono();

dailyLogsRoute.get("/", requireKey("admin"), async (c) => {
  const day = c.req.query("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return c.json({ error: "day=YYYY-MM-DD required" }, 400);
  }
  const appdata = await getAppDataDb();
  return c.json(await searchLogsDay(appdata, day));
});
