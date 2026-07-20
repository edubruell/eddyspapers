import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { openCorpusDb, type CorpusDb } from "../../src/db/corpus.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(__dir, "../fixtures/corpus_fixture.duckdb");
const VEC_PATH = join(__dir, "../fixtures/query_vec.json");

export function requireFixture(): void {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `test fixture missing at ${FIXTURE_PATH} — build it with: npm run build:fixture (needs the full local articles.duckdb)`,
    );
  }
}

export function openFixture(): Promise<CorpusDb> {
  requireFixture();
  return openCorpusDb(FIXTURE_PATH);
}

// The stored embedding of a known fixture paper (see scripts/build_fixture.ts):
// searching with a paper's own vector must rank that paper first.
export function loadQueryVec(): { handle: string; vec: number[] } {
  requireFixture();
  return JSON.parse(readFileSync(VEC_PATH, "utf8")) as { handle: string; vec: number[] };
}
