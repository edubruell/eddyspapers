import { useState } from "react";
import PaperCard from "./PaperCard.jsx";

const MODE_LABEL = {
  keyword: "KEYWORD SWEEP",
  semantic: "SEMANTIC SEARCH",
  journal_scan: "JOURNAL SCAN",
  author: "AUTHOR LOOKUP",
  wp: "WORKING PAPERS",
  editor: "EDITOR TARGETS",
  custom: "SEARCH",
};

export function anchorIdFor(handle) {
  return "paper-" + handle.replace(/[^A-Za-z0-9_-]/g, "_");
}

export default function SectionCard({ section, papers, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const mode = MODE_LABEL[section.mode] ?? "SEARCH";

  return (
    <div className="rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-800">
            {mode}
          </span>
          <span className="truncate text-sm font-medium text-stone-800">
            {section.title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-stone-500">
          <span>
            {section.n_total} found · {section.n_shown} shown
          </span>
          <span>{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-4 pb-4">
          {section.note && (
            <p className="text-xs italic text-stone-500">{section.note}</p>
          )}
          {section.rows.map((row) => {
            const paper = papers[row.handle];
            if (!paper) {
              return (
                <div
                  key={row.handle}
                  className="rounded border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-500"
                >
                  {row.handle}
                </div>
              );
            }
            return (
              <PaperCard
                key={row.handle}
                paper={paper}
                similarity={row.similarity}
                anchorId={anchorIdFor(row.handle)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
