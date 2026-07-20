import { resolveSnapshot } from "../src/sandbox/snapshot.js";
import { computeSearchId } from "../src/agent/cache.js";
import { runAgent } from "../src/agent/runAgent.js";
import type { StreamEvent } from "../src/agent/types.js";

const brief = process.argv[2];
if (!brief) {
  process.stderr.write("Usage: pnpm tsx scripts/record-events.ts \"<brief>\"\n");
  process.exit(1);
}

const snapshot = await resolveSnapshot();
if (!snapshot.exists) {
  process.stderr.write(`[record-events] Warning: DB snapshot not found at ${snapshot.path}\n`);
}

const dbSnapshotDate =
  snapshot.exists && snapshot.ageMs != null
    ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
    : "unknown";

const id = computeSearchId({ brief, dbSnapshotDate });
process.stderr.write(`[record-events] search_id=${id} db=${snapshot.path}\n`);

await runAgent(id, { brief }, snapshot.path, (e: StreamEvent) => {
  process.stdout.write(JSON.stringify(e) + "\n");
});
