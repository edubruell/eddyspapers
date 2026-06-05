import { useEffect, useRef } from "react";
import { SectionLabel, PrimaryButton } from "../primitives/index.jsx";
import CategoryPills from "./CategoryPills.jsx";

// The TASK panel: brief textarea + category pills + advanced (min year) + Run.
// Used both centered (landing) and in the collapsed sidebar (working state).
export default function Sidebar({
  brief,
  setBrief,
  selected,
  toggleCategory,
  onRun,
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
          Press ⌘+Enter or Ctrl+Enter to start.
        </p>
      </div>

      <div>
        <SectionLabel>Journal categories to be considered</SectionLabel>
        <div className="mt-2">
          <CategoryPills selected={selected} onToggle={toggleCategory} disabled={frozen} />
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Need a year cutoff or other filter? Just say so in the task above.
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--border-soft)] pt-3">
        <a
          href="https://econpapers.eduard-bruell.de"
          className="text-xs text-stone-500 hover:text-stone-700"
          title="Just want to search by abstract? Use classic semantic search."
        >
          ← Semantic mode
        </a>
        <PrimaryButton onClick={onRun} disabled={frozen || submitting}>
          {submitting ? "Starting…" : "Run search"}
        </PrimaryButton>
      </div>
    </div>
  );
}
