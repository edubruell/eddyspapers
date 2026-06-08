import { useState } from "react";
import { getPersonProfile } from "../lib/api.js";

function formatCitations(n) {
  if (!n) return "0";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

function sinceYear(first) {
  if (!first) return null;
  return `since ${first}`;
}

function ideasUrl(shortId) {
  return `https://ideas.repec.org/e/${shortId}.html`;
}

function LinkPill({ href, label, small = false }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        "inline-flex items-center rounded border border-stone-200 bg-white px-2 py-0.5 " +
        "text-stone-600 transition hover:bg-stone-50 hover:border-stone-300 " +
        (small ? "text-[10px]" : "text-xs")
      }
    >
      {label}
    </a>
  );
}

function EvidencePaper({ ev, rank }) {
  return (
    <div className="flex gap-2 items-baseline text-xs">
      <span className="shrink-0 text-[10px] font-medium text-[var(--accent-green)] w-4 text-right">{rank}</span>
      <span className="shrink-0 text-stone-400 w-8">{ev.year || "—"}</span>
      <span className="text-stone-700 line-clamp-1 leading-snug">{ev.title || ev.handle}</span>
    </div>
  );
}

function CategoryBreakdown({ cats }) {
  if (!cats || cats.length === 0) return null;
  const filtered = cats.filter((c) => c.category);
  if (filtered.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {filtered.map((c) => (
        <span
          key={c.category}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border-soft)] bg-[var(--bg-card-2)] px-2 py-0.5 text-[10px] text-stone-600"
        >
          {c.category}
          <span className="text-stone-400">{c.n}</span>
        </span>
      ))}
    </div>
  );
}

function AwardsList({ awards }) {
  if (!awards || awards.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {awards.map((a, i) => (
        <li key={i} className="text-xs text-stone-600">{a}</li>
      ))}
    </ul>
  );
}

function GenealogyLine({ advisors, students }) {
  const hasAdvisors = advisors && advisors.length > 0;
  const hasStudents = students && students.length > 0;
  if (!hasAdvisors && !hasStudents) return null;
  return (
    <div className="text-xs text-stone-500 space-y-0.5">
      {hasAdvisors && (
        <div><span className="text-stone-400">Advisor: </span>{advisors.join(", ")}</div>
      )}
      {hasStudents && (
        <div>
          <span className="text-stone-400">Doctoral students: </span>
          {students.slice(0, 8).join(", ")}
          {students.length > 8 && <span className="text-stone-400"> +{students.length - 8} more</span>}
        </div>
      )}
    </div>
  );
}

export default function PersonCard({ person }) {
  const [expanded, setExpanded] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const wp = person.workplace_name || "";

  const years = sinceYear(person.stats?.first_year);
  const cites = formatCitations(person.stats?.total_citations);
  const nPapers = person.stats?.n_works_in_corpus ?? 0;

  async function toggleExpanded() {
    if (!expanded && !profile) {
      setLoadingProfile(true);
      try {
        const p = await getPersonProfile(person.short_id);
        setProfile(p);
      } catch {
        // profile stays null; expanded section shows what we have
      } finally {
        setLoadingProfile(false);
      }
    }
    setExpanded((v) => !v);
  }

  const wd = profile?.wikidata;
  const allLinks = profile ? [
    { href: person.homepage || wd?.website, label: "Homepage" },
    { href: ideasUrl(person.short_id), label: "IDEAS" },
    { href: wd?.google_scholar_id ? `https://scholar.google.com/citations?user=${wd.google_scholar_id}` : null, label: "Scholar" },
    { href: wd?.wikipedia_url, label: "Wikipedia" },
    { href: wd?.orcid ? `https://orcid.org/${wd.orcid}` : null, label: "ORCID" },
    { href: wd?.ssrn_author_id ? `https://papers.ssrn.com/sol3/cf_dev/AbsByAuth.cfm?per_id=${wd.ssrn_author_id}` : null, label: "SSRN" },
    { href: wd?.math_genealogy_id ? `https://www.genealogy.math.ndsu.nodak.edu/id.php?id=${wd.math_genealogy_id}` : null, label: "MathGen" },
  ].filter((l) => l.href) : [];

  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-card)] shadow-sm overflow-hidden">
      {/* ── Collapsed header ── */}
      <div className="p-4">
        <div className="flex gap-3">
          {/* Photo */}
          {person.image_url && (
            <img
              src={person.image_url}
              alt={person.name_full}
              className="h-12 w-12 rounded-full object-cover shrink-0 border border-stone-200"
              onError={(e) => { e.target.style.display = "none"; }}
            />
          )}

          {/* Name + workplace + stats */}
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-stone-900 leading-tight">{person.name_full}</div>
            {wp && <div className="text-xs text-stone-500 mt-0.5 truncate">{wp}</div>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-stone-500">
              <span>{nPapers} corpus papers</span>
              {cites !== "0" && <span>{cites} citations</span>}
              {years && <span>{years}</span>}
              {person.stats?.primary_category && (
                <span className="text-[var(--accent-green)] font-medium">{person.stats.primary_category}</span>
              )}
            </div>
          </div>
        </div>

        {/* Evidence papers */}
        {person.evidence && person.evidence.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {person.evidence.slice(0, 3).map((ev, i) => (
              <EvidencePaper key={i} ev={ev} rank={i + 1} />
            ))}
          </div>
        )}

        {/* Footer: quick links + More */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <LinkPill href={ideasUrl(person.short_id)} label="IDEAS" small />
          {person.homepage && <LinkPill href={person.homepage} label="Homepage" small />}
          <button
            type="button"
            onClick={toggleExpanded}
            disabled={loadingProfile}
            className="ml-auto text-xs text-stone-400 hover:text-stone-600 transition disabled:opacity-50"
          >
            {loadingProfile ? "Loading…" : expanded ? "Less ↑" : "More ↓"}
          </button>
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="border-t border-[var(--border-soft)] bg-[var(--bg-card-2)] px-4 py-4 space-y-4">
          {/* Full link strip */}
          {allLinks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {allLinks.map((l) => (
                <LinkPill key={l.label} href={l.href} label={l.label} />
              ))}
            </div>
          )}

          {/* Category breakdown */}
          {profile?.category_breakdown && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold tracking-widest uppercase text-stone-400">Categories</div>
              <CategoryBreakdown cats={profile.category_breakdown} />
            </div>
          )}

          {/* Awards */}
          {wd?.awards && wd.awards.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold tracking-widest uppercase text-stone-400">Awards</div>
              <AwardsList awards={wd.awards} />
            </div>
          )}

          {/* Academic genealogy */}
          {(wd?.doctoral_advisors?.length > 0 || wd?.doctoral_students?.length > 0) && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold tracking-widest uppercase text-stone-400">Academic genealogy</div>
              <GenealogyLine advisors={wd.doctoral_advisors} students={wd.doctoral_students} />
            </div>
          )}

          {/* All evidence papers */}
          {person.evidence && person.evidence.length > 3 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold tracking-widest uppercase text-stone-400">
                All matched papers
              </div>
              {person.evidence.map((ev, i) => (
                <EvidencePaper key={i} ev={ev} rank={i + 1} />
              ))}
            </div>
          )}

          {/* IDEAS profile link for full paper list */}
          <a
            href={ideasUrl(person.short_id)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
          >
            See all {nPapers > 0 ? `${nPapers} corpus papers` : "papers"} on IDEAS →
          </a>
        </div>
      )}
    </div>
  );
}
