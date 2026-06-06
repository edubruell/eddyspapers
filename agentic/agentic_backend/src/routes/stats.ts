import { Hono } from "hono";
import { env } from "../env.js";

export const statsRoute = new Hono();

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
