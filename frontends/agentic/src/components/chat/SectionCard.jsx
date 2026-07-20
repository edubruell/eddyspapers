import { useState } from "react";
import PaperCard from "./PaperCard.jsx";
import PersonCard from "./PersonCard.jsx";

const MODE_LABEL = {
  keyword: "KEYWORD SWEEP",
  semantic: "SEMANTIC SEARCH",
  journal_scan: "JOURNAL SCAN",
  author: "AUTHOR LOOKUP",
  wp: "WORKING PAPERS",
  editor: "EDITOR TARGETS",
  person: "PERSON SEARCH",
  custom: "SEARCH",
};

// Chip palette by how the section was produced: person searches green, semantic
// searches blue, keyword/SQL/other passes grey.
const MODE_CHIP = {
  person: "bg-emerald-100 text-emerald-800",
  semantic: "bg-sky-100 text-sky-800",
};
const CHIP_FALLBACK = "bg-stone-200 text-stone-600";

const ICON = "h-3 w-3 shrink-0";

function IconPerson() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="5" r="3" />
      <path d="M2.5 13.5a5.5 5.5 0 0 1 11 0v.5h-11v-.5z" />
    </svg>
  );
}

function IconSemantic() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="currentColor" aria-hidden="true">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
      <path d="M13 11l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg
      viewBox="0 0 16 16"
      className={ICON}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  );
}

function modeIcon(mode) {
  if (mode === "person") return <IconPerson />;
  if (mode === "semantic") return <IconSemantic />;
  return <IconSearch />;
}

export function anchorIdFor(handle) {
  return "paper-" + handle.replace(/[^A-Za-z0-9_-]/g, "_");
}

export default function SectionCard({ section, papers, persons = {}, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const mode = MODE_LABEL[section.mode] ?? "SEARCH";
  const chip = MODE_CHIP[section.mode] ?? CHIP_FALLBACK;
  const isPersons = section.kind === "persons";

  return (
    <div className="rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${chip}`}
          >
            {modeIcon(section.mode)}
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
            if (isPersons) {
              const person = persons[row.handle];
              if (!person) {
                return (
                  <div
                    key={row.handle}
                    className="rounded border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-500"
                  >
                    {row.handle}
                  </div>
                );
              }
              return <PersonCard key={row.handle} person={person} />;
            }
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
