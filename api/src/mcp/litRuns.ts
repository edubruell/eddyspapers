import type { StreamEvent } from "../agent/types.js";

// In-flight MCP lit_search runs, held in this process only. A run can outlast what an MCP
// client will wait for one tool call (a refine pass took 12 minutes; one client retried
// after ~60s), so the tool waits a bounded time and otherwise hands back the search_id;
// fetch_search and a repeated identical call join the same run here instead of starting
// or refusing a second one. A row left 'running' in the store with no entry here was cut
// off by a restart.

export type RunOutcome =
  | { kind: "done"; events: StreamEvent[] }
  | { kind: "clarify"; question: string; options: string[] }
  | { kind: "failed"; message: string };

export interface LiveRun {
  keyId: string | null;
  startedAt: number;
  outcome: Promise<RunOutcome>;
}

const live = new Map<string, LiveRun>();

export const liveRun = (searchId: string): LiveRun | undefined => live.get(searchId);

export const liveRunOf = (keyId: string): string | undefined =>
  [...live.entries()].find(([, r]) => r.keyId === keyId)?.[0];

// Long enough for an ordinary run (~45-60s) to come back inline most of the time, short
// enough to answer before a client that gives up at ~60s does.
export const waitMs = (): number => Number(process.env.MCP_LIT_WAIT_MS ?? 40_000);

export function startRun(searchId: string, keyId: string | null, work: () => Promise<RunOutcome>): LiveRun {
  const outcome = work()
    .catch((err: unknown): RunOutcome => ({ kind: "failed", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      if (live.get(searchId) === run) live.delete(searchId);
    });
  const run: LiveRun = { keyId, startedAt: Date.now(), outcome };
  live.set(searchId, run);
  return run;
}

// The outcome, or null when the run is still going after `ms`.
export async function waitFor(run: LiveRun, ms: number): Promise<RunOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([run.outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
