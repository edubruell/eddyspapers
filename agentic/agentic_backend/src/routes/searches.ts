import { Hono } from "hono";
import { getSearchDb } from "../db/singleton.js";

export const searchesRoute = new Hono();

searchesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) {
    return c.json({ error: "Search not found" }, 404);
  }
  return c.json(search);
});
