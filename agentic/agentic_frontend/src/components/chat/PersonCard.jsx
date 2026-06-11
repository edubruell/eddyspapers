import { useState } from "react";

function formatCitations(n) {
  if (!n) return "0";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

function handleToIdeasUrl(handle) {
  const path = handle.replace(/^repec:/i, "").replace(/:/g, "/");
  return `https://ideas.repec.org/${path}`;
}

function LinkPill({ href, label }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded border border-stone-300 bg-white px-2 py-0.5 text-[10px] text-stone-600 transition hover:border-stone-400 hover:bg-stone-100"
    >
      {label}
    </a>
  );
}

function EvidenceRow({ ev, rank }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-4 shrink-0 text-right text-[10px] font-semibold text-emerald-700">
        {rank}
      </span>
      <span className="w-8 shrink-0 tabular-nums text-stone-400">
        {ev.year || ""}
      </span>
      <a
        href={handleToIdeasUrl(ev.handle)}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 truncate leading-snug text-stone-700 hover:underline"
        title={ev.journal ? `${ev.title} (${ev.journal})` : ev.title}
      >
        {ev.title || ev.handle}
      </a>
    </div>
  );
}

// Person result card — the people counterpart to PaperCard. Evidence rows are the
// matched papers that put this person in the results.
export default function PersonCard({ person }) {
  const [expanded, setExpanded] = useState(false);

  const evidence = Array.isArray(person.evidence) ? person.evidence : [];
  const shown = expanded ? evidence : evidence.slice(0, 3);

  const activeYears =
    person.first_year && person.last_year
      ? `${person.first_year}–${person.last_year}`
      : null;

  const stats = [
    person.n_works != null ? `${person.n_works} papers in corpus` : null,
    person.citations != null ? `${formatCitations(person.citations)} citations` : null,
    activeYears ? `active ${activeYears}` : null,
    person.n_matched != null ? `${person.n_matched} matched` : null,
  ].filter(Boolean);

  return (
    <article className="relative flex gap-3 rounded-lg border border-l-4 border-stone-200 border-l-emerald-500 bg-stone-50 px-3 pb-2 pt-2 shadow-sm">
      {person.image_url && (
        <img
          src={person.image_url}
          alt={person.name}
          loading="lazy"
          className="mt-0.5 h-12 w-12 shrink-0 rounded-full border border-stone-200 object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header>
          <h3 className="text-sm font-semibold text-stone-900">
            <a
              href={person.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {person.name}
            </a>
          </h3>
          {person.affiliation && (
            <p className="text-xs text-stone-700">{person.affiliation}</p>
          )}
          {stats.length > 0 && (
            <p className="text-[11px] text-stone-500">{stats.join(" · ")}</p>
          )}
        </header>

        {shown.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
              Matched papers
            </p>
            {shown.map((ev, i) => (
              <EvidenceRow key={ev.handle} ev={ev} rank={i + 1} />
            ))}
          </div>
        )}

        <footer className="mt-1 flex flex-wrap items-center gap-1.5">
          <LinkPill href={person.url} label="IDEAS" />
          <LinkPill href={person.homepage} label="Homepage" />
          <LinkPill href={person.wikipedia_url} label="Wikipedia" />
          <LinkPill
            href={person.orcid ? `https://orcid.org/${person.orcid}` : null}
            label="ORCID"
          />
          {evidence.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-0.5 text-[10px] text-stone-700 hover:bg-stone-100"
            >
              {expanded ? "Less" : `All ${evidence.length} matches`}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}
