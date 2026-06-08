import { useState } from "react";
import { savePersonSearch } from "../lib/api.js";

export default function ShareButton({ query, scoringMode, qualityWeight, results }) {
  const [state, setState] = useState("idle"); // idle | saving | copied | error

  async function onShare() {
    if (state === "saving") return;
    setState("saving");
    try {
      const { hash } = await savePersonSearch({ query, scoringMode, qualityWeight, results });
      const url = new URL(window.location.href);
      url.searchParams.set("s", hash);
      window.history.replaceState({}, "", url.toString());
      await navigator.clipboard.writeText(url.toString()).catch(() => {});
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  const label =
    state === "saving" ? "Saving…" :
    state === "copied" ? "Link copied!" :
    state === "error"  ? "Failed" :
    "Share";

  return (
    <button
      type="button"
      onClick={onShare}
      disabled={state === "saving"}
      className={
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
        (state === "copied"
          ? "border-[var(--accent-green)] bg-[var(--accent-green)] text-white"
          : "border-[var(--border-soft)] bg-[var(--bg-card)] text-stone-600 hover:bg-[var(--bg-card-2)]")
      }
    >
      {state === "copied" ? (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 2h4v4M14 2l-6 6M7 4H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {label}
    </button>
  );
}
