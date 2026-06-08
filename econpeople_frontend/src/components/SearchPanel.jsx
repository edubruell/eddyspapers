import { useEffect, useRef } from "react";

const SCORING_OPTIONS = [
  { value: "breadth",    label: "Most papers",  short: "Breadth" },
  { value: "blended",   label: "Balanced",     short: "Balanced" },
  { value: "best_match", label: "Best match",  short: "Precise" },
];

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange((v) => !v)}
      className="flex items-center gap-2 text-xs text-stone-600 transition disabled:opacity-50"
    >
      <span
        className={
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition " +
          (checked ? "bg-[var(--accent-green)]" : "bg-stone-300")
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

export default function SearchPanel({
  query,
  setQuery,
  scoringMode,
  setScoringMode,
  citationBoost,
  setCitationBoost,
  onSearch,
  loading,
  frozen,
  compact,
  lastUpdated,
}) {
  const taRef = useRef(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, compact ? 180 : 260) + "px";
  }, [query, compact]);

  function onKey(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSearch();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        ref={taRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        disabled={frozen}
        placeholder="Describe a research topic or paste a paper abstract…"
        className={
          "w-full resize-none rounded-xl border border-[var(--border-soft)] bg-[var(--bg-card)] " +
          "px-3 py-2.5 text-sm text-stone-800 placeholder-stone-400 outline-none " +
          "focus:ring-2 focus:ring-[var(--accent-green)] disabled:opacity-60 " +
          (compact ? "min-h-[72px]" : "min-h-[96px]")
        }
      />

      {/* Scoring mode segmented control */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-stone-500">
          Ranking
        </span>
        <div className="flex rounded-lg border border-[var(--border-soft)] bg-[var(--bg-card-2)] p-0.5 gap-0.5">
          {SCORING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={frozen}
              onClick={() => setScoringMode(opt.value)}
              className={
                "flex-1 rounded-md px-1 py-1 text-[10px] font-medium transition whitespace-nowrap " +
                (scoringMode === opt.value
                  ? "bg-white text-stone-900 shadow-sm"
                  : "text-stone-500 hover:text-stone-700")
              }
            >
              {compact ? opt.short : opt.label}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        checked={citationBoost}
        onChange={setCitationBoost}
        disabled={frozen}
        label="Citation boost"
      />

      <button
        type="button"
        disabled={loading || frozen || query.trim().length < 3}
        onClick={onSearch}
        className="rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
        style={{
          background:
            loading || frozen || query.trim().length < 3
              ? "var(--primary-disabled)"
              : "var(--primary)",
        }}
      >
        {loading ? "Searching…" : "Find economists"}
      </button>

      {lastUpdated && !compact && (
        <p className="text-[10px] text-stone-400 text-center">
          Corpus updated {lastUpdated}
        </p>
      )}
    </div>
  );
}
