import { createHash } from "crypto";
import type { AgentInput } from "./types.js";

export function computeSearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const payload = JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    dbSnapshotDate: input.dbSnapshotDate,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
