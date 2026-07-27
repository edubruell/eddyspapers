import { createHash, createHmac } from "crypto";
import type { AgentInput } from "./types.js";
import { env } from "../env.js";

// The cache key spans every input that changes the produced review: the brief, the
// corpus snapshot, and all four steering inputs (categories, min year, must-include
// authors/handles, and whether the refine pass may run). Omitting must_include/refine —
// as Phase 3 shipped — collided distinct searches onto one cached result (PLAN.md §D1).
function searchPayload(input: AgentInput & { dbSnapshotDate: string }): string {
  return JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    mustInclude: input.mustInclude ? [...input.mustInclude].sort() : [],
    refine: input.refine ?? false,
    dbSnapshotDate: input.dbSnapshotDate,
  });
}

// The run ID is HMAC-keyed, not a plain hash: it doubles as the share-link token and the
// SSE-stream path, both served ungated (agentic/08_sharelinks.md). A plain SHA-256 of the
// brief let anyone who knows a brief reconstruct the ID and read the run; keying it with a
// server-only secret keeps IDs unguessable while staying deterministic, so dedup and
// share-by-link both still work. See env.SEARCH_ID_SECRET for the key/trust model.
export function computeSearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const secret = env.SEARCH_ID_SECRET || env.AGENTIC_PASSWORD || "";
  return createHmac("sha256", secret).update(searchPayload(input)).digest("hex").slice(0, 16);
}

// The pre-HMAC ID scheme (plain SHA-256). LOOKUP-ONLY backward compat: runs created before
// the HMAC cutover are stored under this ID, so the dedup path checks it too and serves the
// existing completed run instead of minting a duplicate. Never used to create new runs.
// Remove once the pre-cutover runs age out of appdata.duckdb (a handful of test-phase shares).
export function legacySearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  return createHash("sha256").update(searchPayload(input)).digest("hex").slice(0, 16);
}
