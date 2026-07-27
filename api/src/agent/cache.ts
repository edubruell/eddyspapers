import { createHmac } from "crypto";
import type { AgentInput } from "./types.js";
import { env } from "../env.js";

// The cache key spans every input that changes the produced review: the brief, the
// corpus snapshot, and all four steering inputs (categories, min year, must-include
// authors/handles, and whether the refine pass may run). Omitting must_include/refine —
// as Phase 3 shipped — collided distinct searches onto one cached result (PLAN.md §D1).
//
// It is HMAC-keyed, not a plain hash: the run ID doubles as the share-link token and the
// SSE-stream path, both of which are served ungated (agentic/08_sharelinks.md). A plain
// SHA-256 of the brief let anyone who knows a brief reconstruct the ID and read the run;
// keying it with a server-only secret keeps IDs unguessable while staying deterministic,
// so dedup and share-by-link both still work. See env.SEARCH_ID_SECRET for the key/trust
// model (and the self-serve-keys caveat).
export function computeSearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const payload = JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    mustInclude: input.mustInclude ? [...input.mustInclude].sort() : [],
    refine: input.refine ?? false,
    dbSnapshotDate: input.dbSnapshotDate,
  });
  const secret = env.SEARCH_ID_SECRET || env.AGENTIC_PASSWORD || "";
  return createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
}
