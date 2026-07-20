import { useState } from "react";
import { SimilarityBar } from "../primitives/index.jsx";

function categoryBar(category) {
  if (!category) return "border-l-stone-300";
  if (category.includes("Top 5")) return "border-l-orange-500";
  if (category.includes("General Interest")) return "border-l-amber-500";
  if (category.includes("AEJ")) return "border-l-sky-400";
  if (category.includes("Top Field")) return "border-l-emerald-400";
  if (category.includes("Second in Field")) return "border-l-teal-800";
  if (category.includes("Working Paper")) return "border-l-red-200";
  return "border-l-stone-200";
}

// Visually mirrors the existing app's ResultCard.
export default function PaperCard({ paper, similarity, anchorId }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyBibtex() {
    try {
      await navigator.clipboard.writeText(paper.bibtex || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  const authors = Array.isArray(paper.authors)
    ? paper.authors.join(", ")
    : paper.authors;

  return (
    <article
      id={anchorId}
      className={`relative flex flex-col gap-1 rounded-lg border border-l-4 border-stone-200 bg-stone-50 px-3 pb-2 pt-2 shadow-sm ${categoryBar(
        paper.category,
      )}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">
            <a
              href={paper.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {paper.title}
            </a>
          </h3>
          <p className="text-xs text-stone-700">{authors}</p>
          <p className="text-xs italic text-stone-600">
            {paper.journal} {paper.year ? `(${paper.year})` : null}
          </p>
        </div>
        {typeof similarity === "number" && (
          <div className="whitespace-nowrap text-right text-[11px] text-stone-500">
            <div>Similarity</div>
            <div className="font-semibold text-stone-700">
              {similarity.toFixed(3)}
            </div>
          </div>
        )}
      </header>

      {paper.abstract && (
        <div
          className={`mt-1 text-[12px] leading-snug text-stone-700 ${
            expanded ? "" : "max-h-24 overflow-hidden"
          }`}
        >
          {paper.abstract}
        </div>
      )}

      <footer className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={copyBibtex}
          className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-100"
        >
          {copied ? "Copied" : "BibTeX"}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-100"
        >
          {expanded ? "Less" : "More"}
        </button>
      </footer>
    </article>
  );
}
