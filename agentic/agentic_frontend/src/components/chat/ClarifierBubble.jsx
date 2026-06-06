import { useState } from "react";

// Blocking clarifier turn (06_clarifier.md §7.2). Claude-Code-style: the agent asks one
// question, offers a few concrete choices, and the user either picks one or writes their
// own. The run is paused until they send — `awaiting` gates the interactive form.
export default function ClarifierBubble({ question, options = [], awaiting, onReply }) {
  const [chosen, setChosen] = useState(null);
  const [custom, setCustom] = useState("");
  const [sent, setSent] = useState(false);

  if (!question) return null;

  const answer = custom.trim() || chosen || "";
  const canSend = awaiting && !sent && answer.length > 0;

  function send() {
    if (!canSend) return;
    setSent(true);
    onReply(answer);
  }

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  // Resolved/historical view: question was already answered (or the run moved on).
  if (!awaiting || sent) {
    return (
      <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-card-2)] px-3 py-2 text-sm">
        <div className="flex items-start gap-1.5">
          <img src="/strategy.svg" alt="" aria-hidden="true" className="mt-0.5 h-4 w-4" />
          <div>
            <span className="font-medium text-stone-700">{question}</span>
            {answer && (
              <span className="text-stone-500">
                {" "}
                — <span className="italic">{answer}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border-l-2 border-[var(--accent-purple)] bg-[var(--bg-card-2)] px-3 py-3">
      <div className="flex items-start gap-1.5">
        <img src="/strategy.svg" alt="" aria-hidden="true" className="mt-0.5 h-4 w-4" />
        <div className="flex-1">
          <p className="text-sm font-medium text-stone-800">{question}</p>

          {options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {options.map((opt) => {
                const active = chosen === opt && !custom.trim();
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      setChosen(opt);
                      setCustom("");
                    }}
                    className={
                      "rounded-full border px-3 py-1 text-xs transition " +
                      (active
                        ? "border-transparent bg-[var(--accent-purple)] text-white"
                        : "border-stone-300 bg-white text-stone-700 hover:border-stone-400")
                    }
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                if (e.target.value) setChosen(null);
              }}
              onKeyDown={onKeyDown}
              placeholder={
                options.length > 0 ? "Or write your own answer…" : "Type your answer…"
              }
              className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 outline-none focus:border-stone-400 focus:ring-2 focus:ring-[color:var(--primary-disabled)]"
            />
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              onMouseDown={(e) => e.preventDefault()}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50"
              style={{ background: canSend ? "var(--primary)" : "var(--primary-disabled)" }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
