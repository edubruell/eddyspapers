import { openSearchDb, type SearchDb } from "./searches.js";

let instance: SearchDb | null = null;

export async function getSearchDb(): Promise<SearchDb> {
  if (!instance) {
    instance = await openSearchDb();
  }
  return instance;
}
