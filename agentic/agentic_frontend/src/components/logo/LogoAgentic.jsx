// Placeholder until Eddy's hand-drawn Diogenes/detective meerkat ships
// (03_interface.md §2, decision 4). A simple magnifying-glass mark keeps
// the wordmark layout correct in the meantime.
export default function LogoAgentic({ compact = false }) {
  return (
    <div className={compact ? "flex items-center gap-2" : "flex flex-col items-center gap-1"}>
      <div
        className={
          compact
            ? "flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-card-2)] border border-[var(--border-soft)]"
            : "flex h-20 w-20 items-center justify-center rounded-full bg-[var(--bg-card-2)] border border-[var(--border-soft)]"
        }
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-orange)"
          strokeWidth="1.8"
          className={compact ? "h-5 w-5" : "h-9 w-9"}
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 L21 21" strokeLinecap="round" />
        </svg>
      </div>
      <div className={compact ? "leading-tight" : "text-center leading-tight"}>
        <div
          className={compact ? "text-sm font-semibold" : "text-xl font-semibold"}
          style={{ color: "var(--accent-orange)" }}
        >
          Eddy's Papers
        </div>
        <div
          className={
            (compact ? "text-[10px]" : "text-xs") + " font-semibold tracking-[0.14em]"
          }
          style={{ color: "var(--accent-sky)" }}
        >
          AGENTIC SEARCH
        </div>
        {!compact && (
          <div className="text-[11px]" style={{ color: "var(--accent-orange)" }}>
            by Eduard Brüll
          </div>
        )}
      </div>
    </div>
  );
}
