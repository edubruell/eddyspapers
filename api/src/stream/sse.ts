import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { bus } from "./bus.js";
import type { StreamEvent } from "../agent/types.js";

const HEARTBEAT_MS = 15_000;

// Awaited writer loop: every event (replayed + live) goes through a queue and is
// written with backpressure, so the terminal `done`/`error` event always flushes
// before the stream closes. The previous fire-and-forget approach raced resolve()
// against un-awaited writes, which dropped the tail of the stream (the stepper's
// final stage-exit + done) — leaving the UI spinner stuck — and made replaying a
// completed run return nothing.
export function toSSEResponse(c: Context, searchId: string, lastEventId: string | null): Response {
  return streamSSE(c, async (stream) => {
    const fromSeq = lastEventId != null ? parseInt(lastEventId, 10) + 1 : 0;

    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    let aborted = false;

    const push = (e: StreamEvent): void => {
      queue.push(e);
      if (wake) {
        wake();
        wake = null;
      }
    };

    stream.onAbort(() => {
      aborted = true;
      if (wake) {
        wake();
        wake = null;
      }
    });

    // subscribe() synchronously replays buffered events (seq >= fromSeq) into the
    // queue, then registers `push` for live events.
    const unsubscribe = bus.subscribe(searchId, fromSeq, push);

    const writeEvent = (e: StreamEvent): Promise<void> =>
      stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });

    const isTerminal = (e: StreamEvent): boolean =>
      e.type === "done" || (e.type === "error" && !e.recoverable);

    try {
      let finished = false;
      while (!finished && !aborted) {
        if (queue.length === 0) {
          if (bus.isDone(searchId)) break; // run finished and queue drained
          // wait for the next event or a heartbeat interval
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (!aborted && queue.length === 0 && !bus.isDone(searchId)) {
            await stream.writeSSE({ event: "ping", data: "{}" });
          }
          continue;
        }
        const e = queue.shift()!;
        await writeEvent(e);
        if (isTerminal(e)) finished = true;
      }
      // flush anything still queued (e.g. events buffered just before `done`)
      while (!aborted && queue.length > 0) {
        await writeEvent(queue.shift()!);
      }
    } finally {
      unsubscribe();
    }
  });
}
