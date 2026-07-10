import { openSearchDb, type SearchDb } from "./searches.js";
import { openCorpusDb, type CorpusDb } from "./corpus.js";

let instance: SearchDb | null = null;

export async function getSearchDb(): Promise<SearchDb> {
  if (!instance) {
    instance = await openSearchDb();
  }
  return instance;
}

let corpus: Promise<CorpusDb> | null = null;

// Promise-cached (not instance-cached) so concurrent first requests share one
// open instead of racing to create duplicate pools. A failed open clears the
// cache — otherwise one transient failure (snapshot mid-swap) 500s every later
// request until restart.
export function getCorpusDb(): Promise<CorpusDb> {
  if (!corpus) {
    corpus = openCorpusDb().catch((err: unknown) => {
      corpus = null;
      throw err;
    });
  }
  return corpus;
}
