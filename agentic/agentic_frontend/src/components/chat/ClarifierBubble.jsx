// Inline "Quick question:" prompt (03_interface.md §10.1). The pipeline proceeds
// optimistically, so this is informational in v1 — no reply round-trip yet.
export default function ClarifierBubble({ question }) {
  if (!question) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-stone-700">
      <span className="font-semibold text-amber-700">Quick note: </span>
      {question}
    </div>
  );
}
