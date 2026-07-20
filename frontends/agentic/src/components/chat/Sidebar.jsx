import { useEffect, useRef } from "react";
import { SectionLabel, PrimaryButton } from "../primitives/index.jsx";

// A small pill toggle matching the purple accent. Used for the per-run agent settings.
function Toggle({ checked, onChange, disabled, label, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange((v) => !v)}
      title={title}
      className="flex items-center gap-2 text-xs text-stone-600 transition disabled:opacity-50"
    >
      <span
        className={
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition " +
          (checked ? "bg-[var(--accent-purple)]" : "bg-stone-300")
        }
      >
        <span
          className={
            "inline-block h-3 w-3 transform rounded-full bg-white shadow transition " +
            (checked ? "translate-x-3.5" : "translate-x-0.5")
          }
        />
      </span>
      {label}
    </button>
  );
}

// The TASK panel: just a brief textarea + Run. Journal-tier selection is no longer
// a UI control — the agent infers the appropriate categories from the brief (the
// tier vocabulary still lives in the backend writer prompt). Year cutoffs and other
// filters are expressed in plain language inside the brief.
// Used both centered (landing) and in the collapsed sidebar (working state).
export default function Sidebar({
  brief,
  setBrief,
  onRun,
  onNewSearch,
  skipClarify,
  setSkipClarify,
  refine,
  setRefine,
  submitting,
  frozen,
  compact,
}) {
  const taRef = useRef(null);

  // autosize the textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, compact ? 200 : 280) + "px";
  }, [brief, compact]);

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!frozen && !submitting) onRun();
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <SectionLabel>Task</SectionLabel>
        <textarea
          ref={taRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={onKeyDown}
          readOnly={frozen}
          rows={3}
          placeholder="Describe what you're looking for. The more context, the better the review."
          className={
            "mt-1 w-full resize-none rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 outline-none focus:border-stone-400 focus:ring-2 focus:ring-sky-200 " +
            (frozen ? "opacity-70" : "")
          }
        />
        <p className="mt-1 text-xs text-stone-500">
          Specify years, journals, authors and topics directly in your task
          description.
        </p>
        <p className="mt-1 text-xs text-stone-500">
          Press ⌘+Enter or Ctrl+Enter to start.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          <Toggle
            checked={skipClarify}
            onChange={setSkipClarify}
            disabled={frozen}
            label="Skip clarifying questions"
            title="When on, the agent never pauses to ask — it makes its best guess and runs straight through."
          />
          <Toggle
            checked={refine}
            onChange={setRefine}
            disabled={frozen}
            label="Refine strategy (multi-stage)"
            title="When on, the agent reviews its first results and, if they look weak, runs one corrected pass before writing up."
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--border-soft)] pt-3">
        <a
          href="https://econpapers.eduard-bruell.de"
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-card-2)] px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:text-stone-900"
          title="Just want to search by abstract? Use classic semantic search."
        >
          ← Semantic Search
        </a>
        <PrimaryButton onClick={onRun} disabled={frozen || submitting}>
          {submitting ? "Starting…" : "Run search"}
        </PrimaryButton>
      </div>

      {compact && onNewSearch && (
        <button
          type="button"
          onClick={onNewSearch}
          className="w-full rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-100"
        >
          New search
        </button>
      )}
    </div>
  );
}
