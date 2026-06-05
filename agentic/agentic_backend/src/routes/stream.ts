import { Hono } from "hono";
import { toSSEResponse } from "../stream/sse.js";
import { getSearchDb } from "../db/singleton.js";

export const streamRoute = new Hono();

streamRoute.get("/:id/stream", async (c) => {
  const id = c.req.param("id");
  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) {
    return c.json({ error: "Search not found" }, 404);
  }
  const lastEventId = c.req.header("Last-Event-ID") ?? null;
  return toSSEResponse(c, id, lastEventId);
});
