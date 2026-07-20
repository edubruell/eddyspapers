// Shared primitives mirroring the semantic-search app's look
// (cream cards, stone borders, navy primary). Kept in one file for brevity.

export function Card({ className = "", children }) {
  return (
    <div
      className={
        "rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] shadow-sm " +
        className
      }
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children, className = "" }) {
  return (
    <div
      className={
        "text-[11px] font-semibold tracking-[0.08em] uppercase text-stone-600 " +
        className
      }
    >
      {children}
    </div>
  );
}

export function PrimaryButton({ children, disabled, onClick, type = "button" }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
      style={{ background: disabled ? "var(--primary-disabled)" : "var(--primary)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, disabled, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-700 transition hover:bg-stone-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function SimilarityBar({ score }) {
  // green (1.0) → red (0.0), matching the existing result cards
  const s = typeof score === "number" ? Math.max(0, Math.min(1, score)) : 0.5;
  const hi = [47, 158, 92];
  const lo = [192, 70, 58];
  const mix = hi.map((h, i) => Math.round(lo[i] + (h - lo[i]) * s));
  return (
    <span
      className="mr-2 inline-block w-1 self-stretch rounded"
      style={{ background: `rgb(${mix[0]},${mix[1]},${mix[2]})` }}
      aria-hidden="true"
    />
  );
}
