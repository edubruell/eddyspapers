import { Hono } from "hono";
import { getCorpusDb } from "../db/singleton.js";
import { corpusGuide } from "../search/guide.js";

export const corpusRoute = new Hono();

// Public like /stats/last_updated: reference metadata, no user data, cheap
// (computed once per process). PLAN.md §B3.
corpusRoute.get("/guide", async (c) => {
  const db = await getCorpusDb();
  return c.json(await corpusGuide(db));
});
