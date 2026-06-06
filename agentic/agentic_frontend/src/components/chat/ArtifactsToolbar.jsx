import { GhostButton } from "../primitives/index.jsx";

function download(name, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// File-type glyphs for the export buttons. Each is a 16px document tinted to the
// convention for its format (PDF red, Excel green, BibTeX brand purple, Markdown stone),
// with a small interior motif so they stay distinct at a glance even in greyscale.
const ICON = "h-4 w-4 shrink-0";
const DOC = "M4 1.5h5L12 5v8.5a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5Z";
const FOLD = "M9 1.5V5h3";

function IconPdf() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="#dc2626" strokeWidth="1" aria-hidden="true">
      <path d={DOC} />
      <path d={FOLD} />
      <path d="M5.6 11.4c1.3-.5 2.2-2 2.8-3.6.5-1.4.3-2.3-.2-2.3-.6 0-.8 1-.4 2.3.5 1.6 1.6 3 2.9 3.4" strokeWidth=".9" strokeLinecap="round" />
    </svg>
  );
}

function IconExcel() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="#15803d" strokeWidth="1" aria-hidden="true">
      <path d={DOC} />
      <path d={FOLD} />
      <path d="M5 7.3h6v5H5zM5 9.8h6M8 7.3v5" strokeWidth=".8" strokeLinejoin="round" />
    </svg>
  );
}

function IconBibtex() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="#7c3aed" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.6 3.2c-1.2 0-1.5.7-1.5 1.8 0 1-.3 1.7-1 1.7.7 0 1 .7 1 1.7v1.1c0 1.1.3 1.8 1.5 1.8" />
      <path d="M9.4 3.2c1.2 0 1.5.7 1.5 1.8 0 1 .3 1.7 1 1.7-.7 0-1 .7-1 1.7v1.1c0 1.1-.3 1.8-1.5 1.8" />
    </svg>
  );
}

function IconMarkdown() {
  return (
    <svg viewBox="0 0 16 16" className={ICON} fill="none" stroke="#57534e" strokeWidth="1" aria-hidden="true">
      <path d={DOC} />
      <path d={FOLD} />
      <path d="M5.2 11V8l1.6 1.6L8.4 8v3M10.6 8v3M9.4 9.8l1.2 1.2 1.2-1.2" strokeWidth=".9" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// MVP: client-side BibTeX + Markdown export. Server-rendered PDF/XLSX are Phase 8.
export default function ArtifactsToolbar({ bibtex, synthesis }) {
  const hasBib = bibtex && bibtex.bibtex;
  const hasMd = synthesis && synthesis.length > 0;
  if (!hasBib && !hasMd) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <GhostButton disabled title="Server-rendered PDF — coming soon">
        <IconPdf />
        PDF
      </GhostButton>
      <GhostButton disabled title="Excel export — coming soon">
        <IconExcel />
        Excel
      </GhostButton>
      <GhostButton
        disabled={!hasBib}
        onClick={() => download("references.bib", bibtex.bibtex)}
      >
        <IconBibtex />
        BibTeX
      </GhostButton>
      <GhostButton
        disabled={!hasMd}
        onClick={() => download("review.md", synthesis, "text/markdown;charset=utf-8")}
      >
        <IconMarkdown />
        Markdown
      </GhostButton>
    </div>
  );
}
