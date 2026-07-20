import { initialState, reduceEvent } from "./store.js";

// Fold a stored events array into the same render state the live SSE UI produces — the
// shared-view counterpart to useAgentStream, but from persisted JSON instead of a stream
// (08_sharelinks.md §2). One reducer, two sources → identical state.
export function replayEvents(events) {
  if (!Array.isArray(events)) return initialState();
  return events.reduce((state, e) => reduceEvent(state, e), initialState());
}
