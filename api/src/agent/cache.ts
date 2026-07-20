import { createHash } from "crypto";
import type { AgentInput } from "./types.js";

// The cache key spans every input that changes the produced review: the brief, the
// corpus snapshot, and all four steering inputs (categories, min year, must-include
// authors/handles, and whether the refine pass may run). Omitting must_include/refine —
// as Phase 3 shipped — collided distinct searches onto one cached result (PLAN.md §D1).
export function computeSearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const payload = JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    mustInclude: input.mustInclude ? [...input.mustInclude].sort() : [],
    refine: input.refine ?? false,
    dbSnapshotDate: input.dbSnapshotDate,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
