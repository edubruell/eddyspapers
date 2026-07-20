import { useState } from "react";

export default function ShareButton({ id }) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;

  async function copy() {
    const url = `${window.location.origin}/c?s=${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy a read-only link to this search"
      className={
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
        (copied
          ? "border-[var(--accent-purple)] bg-[var(--accent-purple)] text-white"
          : "border-[var(--border-soft)] bg-[var(--bg-card)] text-stone-600 hover:bg-[var(--bg-card-2)]")
      }
    >
      {copied ? (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 2h4v4M14 2l-6 6M7 4H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {copied ? "Link copied!" : "Share"}
    </button>
  );
}
