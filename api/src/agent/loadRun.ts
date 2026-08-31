import { getSearchDb } from "../db/singleton.js";
import { buildBundle, type SearchBundle } from "./bundle.js";
import type { StoredSearch } from "../db/searches.js";

// Rebuild a stored run into the same bundle lit_search returned. Shared by the
// agenticsearch://searches resources and the fetch_search tool so a run reads back
// identically whichever face fetches it. Returns null for an unknown id — the callers
// answer with a structured not-found rather than throwing.
export async function loadRun(id: string): Promise<{ search: StoredSearch; bundle: SearchBundle } | null> {
  const db = await getSearchDb();
  const search = await db.getSearch(id);
  if (!search) return null;
  return { search, bundle: buildBundle(id, search.brief, search.events) };
}
