import { stat } from "fs/promises";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

export interface SnapshotInfo {
  path: string;
  exists: boolean;
  ageMs: number | null;
  stale: boolean;
}

export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
export const PRODUCTION_SNAPSHOT_PATH = "/var/lib/eddysearch/snapshot.duckdb";

function candidatePaths(): string[] {
  const candidates: string[] = [];

  const explicit = process.env["DB_SNAPSHOT"];
  if (explicit) candidates.push(explicit);

  const dbFolder = process.env["PAPER_SEARCH_DB"];
  if (dbFolder) candidates.push(join(dbFolder, "articles.duckdb"));

  const dataRoot = process.env["PAPER_SEARCH_DATA_ROOT"];
  if (dataRoot) candidates.push(join(dataRoot, "db", "articles.duckdb"));

  // src/sandbox → agentic_backend/src → agentic_backend → agentic → eddyspapers root
  candidates.push(resolve(__dir, "../../../../data/db/articles.duckdb"));

  candidates.push(PRODUCTION_SNAPSHOT_PATH);

  return candidates;
}

export async function resolveSnapshot(override?: string): Promise<SnapshotInfo> {
  const paths = override ? [override] : candidatePaths();

  for (const path of paths) {
    try {
      const st = await stat(path);
      const ageMs = Date.now() - st.mtimeMs;
      const stale = ageMs > STALE_THRESHOLD_MS;
      if (stale) {
        console.warn(
          `[snapshot] DB snapshot at ${path} is ${Math.round(ageMs / 86_400_000)} days old — consider re-running update_repec.R`
        );
      }
      return { path, exists: true, ageMs, stale };
    } catch {
      continue;
    }
  }

  return { path: paths.at(-1)!, exists: false, ageMs: null, stale: false };
}
