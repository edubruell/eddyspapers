import type { StreamEvent } from "../agent/types.js";

interface BusEntry {
  events: StreamEvent[];
  done: boolean;
  listeners: Set<(e: StreamEvent) => void>;
}

export class EventBus {
  private entries = new Map<string, BusEntry>();

  private entry(searchId: string): BusEntry {
    let e = this.entries.get(searchId);
    if (!e) {
      e = { events: [], done: false, listeners: new Set() };
      this.entries.set(searchId, e);
    }
    return e;
  }

  publish(searchId: string, event: StreamEvent): void {
    const e = this.entry(searchId);
    e.events.push(event);
    if (event.type === "done" || (event.type === "error" && !event.recoverable)) {
      e.done = true;
    }
    for (const cb of e.listeners) {
      try { cb(event); } catch { /* listener errors don't kill the bus */ }
    }
  }

  // Returns an unsubscribe function. Replays buffered events from fromSeq before registering.
  subscribe(searchId: string, fromSeq: number, cb: (e: StreamEvent) => void): () => void {
    const e = this.entry(searchId);
    // Replay buffered events the client hasn't seen yet
    for (const ev of e.events) {
      if (ev.seq >= fromSeq) {
        try { cb(ev); } catch { /* ignore */ }
      }
    }
    if (e.done) return () => undefined;
    e.listeners.add(cb);
    return () => { e.listeners.delete(cb); };
  }

  isDone(searchId: string): boolean {
    return this.entries.get(searchId)?.done ?? false;
  }

  cleanup(searchId: string): void {
    this.entries.delete(searchId);
  }
}

export const bus = new EventBus();
