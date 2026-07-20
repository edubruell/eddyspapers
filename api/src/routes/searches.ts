import { Hono } from "hono";
import { getSearchDb } from "../db/singleton.js";
import type { StoredSearch } from "../db/searches.js";

export interface ShareDto {
  id: string;
  brief: string;
  status: StoredSearch["status"];
  createdAt: string;
  minYear: number | null;
  categories: string[] | null;
  events: StoredSearch["events"];
}

// Lean, public-safe projection of a stored run — the share-link contract (08_sharelinks.md §3).
// Internal columns (clarify answer, snapshot date, synthesis blob) are dropped; `events` is the
// canonical replay payload.
export function toShareDto(s: StoredSearch): ShareDto {
  return {
    id: s.id,
    brief: s.brief,
    status: s.status,
    createdAt: s.createdAt,
    minYear: s.minYear,
    categories: s.categories,
    events: s.events,
  };
}

export const searchesRoute = new Hono();

// Public, ungated read of a stored run — the data source for share links (08_sharelinks.md).
// A stored result is free to serve and the search_id is an unguessable hash, so this sits
// outside requireAuth; only *running* a search (which spends tokens) is gated. `events` is the
// canonical replay payload — the share view folds it through the same reducer as the live UI.
searchesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) {
    return c.json({ error: "Search not found" }, 404);
  }
  return c.json(toShareDto(search));
});
