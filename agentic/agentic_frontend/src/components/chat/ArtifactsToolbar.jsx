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

// MVP: client-side BibTeX + Markdown export. Server-rendered PDF/XLSX are Phase 8.
export default function ArtifactsToolbar({ bibtex, synthesis }) {
  const hasBib = bibtex && bibtex.bibtex;
  const hasMd = synthesis && synthesis.length > 0;
  if (!hasBib && !hasMd) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <GhostButton disabled title="Server-rendered PDF — coming soon">
        PDF
      </GhostButton>
      <GhostButton disabled title="Excel export — coming soon">
        Excel
      </GhostButton>
      <GhostButton
        disabled={!hasBib}
        onClick={() => download("references.bib", bibtex.bibtex)}
      >
        BibTeX
      </GhostButton>
      <GhostButton
        disabled={!hasMd}
        onClick={() => download("review.md", synthesis, "text/markdown;charset=utf-8")}
      >
        Markdown
      </GhostButton>
    </div>
  );
}
