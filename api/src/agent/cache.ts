import { createHash, createHmac } from "crypto";
import type { AgentInput } from "./types.js";
import { env } from "../env.js";

// The cache key spans every input that changes the produced review: the brief, the
// corpus snapshot, and all four steering inputs (categories, min year, must-include
// authors/handles, and whether the refine pass may run). Omitting must_include/refine —
// as Phase 3 shipped — collided distinct searches onto one cached result (PLAN.md §D1).
// `synthesize` belongs here for the same reason: a script-only run and a synthesised run of
// the same brief are different artifacts, and serving the cached former for the latter would
// silently drop the review the caller paid for.
function searchPayload(input: AgentInput & { dbSnapshotDate: string }): string {
  return JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    mustInclude: input.mustInclude ? [...input.mustInclude].sort() : [],
    refine: input.refine ?? false,
    synthesize: input.synthesize ?? false,
    dbSnapshotDate: input.dbSnapshotDate,
  });
}

// The run ID is HMAC-keyed, not a plain hash: it doubles as the share-link token and the
// SSE-stream path, both served ungated (agentic/08_sharelinks.md). A plain SHA-256 of the
// brief let anyone who knows a brief reconstruct the ID and read the run; keying it with a
// server-only secret keeps IDs unguessable while staying deterministic, so dedup and
// share-by-link both still work. The secret is server-only — no user-facing credential is
// ever used as the key — and index.ts refuses to boot a gated deployment without it.
// See env.SEARCH_ID_SECRET for the key/trust model.
export function computeSearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const secret = env.SEARCH_ID_SECRET;
  return createHmac("sha256", secret).update(searchPayload(input)).digest("hex").slice(0, 16);
}

// The pre-HMAC ID scheme (plain SHA-256). LOOKUP-ONLY backward compat: runs created before
// the HMAC cutover are stored under this ID, so the dedup path checks it too and serves the
// existing completed run instead of minting a duplicate. Never used to create new runs.
//
// Its payload is FROZEN at the shape those runs were hashed with — it must reproduce history,
// not track the live format, so it deliberately does not share searchPayload above. (Folding
// `synthesize` into a shared payload would have made every legacy lookup miss silently.)
// Remove once the pre-cutover runs age out of appdata.duckdb (a handful of test-phase shares).
export function legacySearchId(input: AgentInput & { dbSnapshotDate: string }): string {
  const frozen = JSON.stringify({
    brief: input.brief,
    categories: input.categories ? [...input.categories].sort() : [],
    minYear: input.minYear ?? null,
    mustInclude: input.mustInclude ? [...input.mustInclude].sort() : [],
    refine: input.refine ?? false,
    dbSnapshotDate: input.dbSnapshotDate,
  });
  return createHash("sha256").update(frozen).digest("hex").slice(0, 16);
}
