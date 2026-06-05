import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { bus } from "./bus.js";
import type { StreamEvent } from "../agent/types.js";

const HEARTBEAT_MS = 15_000;

export function toSSEResponse(c: Context, searchId: string, lastEventId: string | null): Response {
  return streamSSE(c, async (stream) => {
    const fromSeq = lastEventId != null ? parseInt(lastEventId, 10) + 1 : 0;

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
    }, HEARTBEAT_MS);

    await new Promise<void>((resolve) => {
      const sendEvent = (e: StreamEvent): void => {
        stream
          .writeSSE({ id: String(e.seq), data: JSON.stringify(e) })
          .catch(() => undefined);
        if (e.type === "done" || (e.type === "error" && !e.recoverable)) {
          resolve();
        }
      };

      const unsubscribe = bus.subscribe(searchId, fromSeq, sendEvent);

      // If the run is already done and subscribe replayed everything, resolve immediately
      if (bus.isDone(searchId)) {
        unsubscribe();
        resolve();
      }

      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });

    clearInterval(heartbeat);
  });
}
