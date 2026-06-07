import { useState } from "react";

// Copies a read-only permalink to the current run (08_sharelinks.md §4). Sits at the top of
// the results list; same clipboard pattern as PaperCard's BibTeX copy.
export default function ShareButton({ id }) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;

  async function copy() {
    const url = `${window.location.origin}/c?s=${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — no-op rather than interrupt with a dialog */
    }
  }

  return (
    <div className="flex items-center justify-end">
      <button
        type="button"
        onClick={copy}
        title="Copy a read-only link to this search"
        className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.5 8.5a2.5 2.5 0 0 0 3.6.1l2-2a2.5 2.5 0 0 0-3.5-3.6l-1 1" />
          <path d="M9.5 7.5a2.5 2.5 0 0 0-3.6-.1l-2 2a2.5 2.5 0 0 0 3.5 3.6l1-1" />
        </svg>
        {copied ? "Link copied" : "Share"}
      </button>
    </div>
  );
}
