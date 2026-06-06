// Plain-language search plan shown in place of the R script (decided 2026-06-05).
// Never renders code — just one/two sentences from the writer's `strategy` field.
export default function StrategyPanel({ strategy, pending }) {
  if (!strategy && !pending) return null;
  return (
    <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-card-2)] px-3 py-2">
      <div className="flex items-center gap-1.5">
        <img src="/strategy.svg" alt="" aria-hidden="true" className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-600">
          Search strategy
        </span>
      </div>
      <p className="mt-1 text-sm text-stone-700">
        {strategy ?? (
          <span className="italic text-stone-400">Planning the search…</span>
        )}
      </p>
    </div>
  );
}
