import { useEffect, useReducer, useRef } from "react";
import { streamUrl } from "./api.js";
import { initialState, reduceEvent } from "./store.js";

// Subscribes to the backend SSE stream for a given search id and reduces
// the event taxonomy into render state. EventSource handles Last-Event-ID
// reconnection for us; the "ping" heartbeat is a named event we ignore.
export function useAgentStream(id) {
  const [state, dispatch] = useReducer(
    (s, e) => (e === null ? initialState() : reduceEvent(s, e)),
    undefined,
    initialState,
  );
  const esRef = useRef(null);

  useEffect(() => {
    if (!id) return;
    dispatch(null); // reset for a fresh run

    const es = new EventSource(streamUrl(id));
    esRef.current = es;

    es.onmessage = (msg) => {
      let evt;
      try {
        evt = JSON.parse(msg.data);
      } catch {
        return;
      }
      dispatch(evt);
      if (evt.type === "done" || (evt.type === "error" && !evt.recoverable)) {
        es.close();
      }
    };

    es.onerror = () => {
      // Let EventSource auto-reconnect; if the run already finished the
      // server closes the stream and we stop above on the `done` event.
    };

    return () => es.close();
  }, [id]);

  return state;
}
