import { useState } from "react";
import { getPersonProfile, getPersonPapers } from "../lib/api.js";

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
      <span className="shrink-0 text-[10px] font-semibold text-[var(--accent-green)] w-4 text-right">{rank}</span>
      <span className="shrink-0 text-stone-400 w-8 tabular-nums">{ev.year || "—"}</span>
      <span className="text-stone-700 line-clamp-1 leading-snug">{ev.title || ev.handle}</span>
    </div>
  );
}

function handleToIdeasUrl(handle, workType) {
  const prefix = { paper: "p", article: "a", chapter: "h", book: "b", software: "e", "editor-book": "b", "editor-series": "s" }[workType] ?? "p";
  const path = handle.replace(/^repec:/, "").replace(/:/g, "/");
  return `https://ideas.repec.org/${prefix}/${path}.html`;
}

function CorpusPaper({ paper }) {
  const cites = paper.citations ? formatCitations(paper.citations) : null;
  const href  = paper.url || handleToIdeasUrl(paper.handle, paper.work_type);
  return (
    <div className="flex gap-2 items-baseline text-xs py-1 border-b border-[var(--border-soft)] last:border-0">
      <span className="shrink-0 text-stone-400 w-8 tabular-nums">{paper.year || "—"}</span>
      <div className="flex-1 min-w-0">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-stone-800 leading-snug line-clamp-2 font-medium hover:text-[var(--primary)] hover:underline"
        >
          {paper.title || paper.handle}
        </a>
        {paper.journal && (
          <div className="text-stone-400 text-[10px] mt-0.5 truncate">{paper.journal}</div>
        )}
      </div>
      {cites && cites !== "0" && (
        <span className="shrink-0 text-[10px] text-stone-400 tabular-nums">{cites} cit.</span>
      )}
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
        <li key={i} className="text-xs text-stone-700">{a}</li>
      ))}
    </ul>
  );
}

const EDUCATION_PREVIEW = 3;
const STUDENTS_PREVIEW  = 8;

function GenealogySection({ advisors, students, educatedAt }) {
  const [showAllEdu, setShowAllEdu]         = useState(false);
  const [showAllStudents, setShowAllStudents] = useState(false);

  const hasAdvisors  = advisors   && advisors.length > 0;
  const hasStudents  = students   && students.length > 0;
  const hasEducation = educatedAt && educatedAt.length > 0;
  if (!hasAdvisors && !hasStudents && !hasEducation) return null;

  const eduList      = showAllEdu      ? educatedAt : educatedAt?.slice(0, EDUCATION_PREVIEW);
  const studentList  = showAllStudents ? students   : students?.slice(0, STUDENTS_PREVIEW);

  return (
    <div className="space-y-2 text-xs">
      {hasEducation && (
        <div>
          <span className="text-stone-400 font-medium">Educated at: </span>
          <span className="text-stone-700">{eduList.join(", ")}</span>
          {educatedAt.length > EDUCATION_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAllEdu((v) => !v)}
              className="ml-1 text-[var(--primary)] hover:underline"
            >
              {showAllEdu ? "less" : `+${educatedAt.length - EDUCATION_PREVIEW} more`}
            </button>
          )}
        </div>
      )}
      {hasAdvisors && (
        <div>
          <span className="text-stone-400 font-medium">Doctoral advisor: </span>
          <span className="text-stone-700">{advisors.join(", ")}</span>
        </div>
      )}
      {hasStudents && (
        <div>
          <span className="text-stone-400 font-medium">Doctoral students: </span>
          <span className="text-stone-700">
            {studentList.join(", ")}
            {students.length > STUDENTS_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllStudents((v) => !v)}
                className="ml-1 text-[var(--primary)] hover:underline"
              >
                {showAllStudents ? "less" : `+${students.length - STUDENTS_PREVIEW} more`}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function PersonPhoto({ src, name, size = "sm" }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) return null;
  const cls = size === "lg"
    ? "h-20 w-20 rounded-xl object-cover shrink-0 border border-stone-200 shadow-sm"
    : "h-12 w-12 rounded-full object-cover shrink-0 border border-stone-200";
  return (
    <img
      src={src}
      alt={name}
      className={cls}
      onError={() => setErrored(true)}
    />
  );
}

export default function PersonCard({ person }) {
  const [expanded, setExpanded]           = useState(false);
  const [profile, setProfile]             = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [showPapers, setShowPapers]       = useState(false);
  const [papers, setPapers]               = useState(null);
  const [loadingPapers, setLoadingPapers] = useState(false);

  const wp    = person.workplace_name || "";
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
        // profile stays null
      } finally {
        setLoadingProfile(false);
      }
    }
    setExpanded((v) => !v);
  }

  async function togglePapers() {
    if (!showPapers && !papers) {
      setLoadingPapers(true);
      try {
        const p = await getPersonPapers(person.short_id);
        setPapers(p);
      } catch {
        setPapers({ in_corpus: [], counts: { in_corpus: 0 } });
      } finally {
        setLoadingPapers(false);
      }
    }
    setShowPapers((v) => !v);
  }

  const wd = profile?.wikidata;
  // Prefer profile image (larger/fresher) over the search-result thumbnail
  const displayImage = wd?.image_url || person.image_url;

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
          {/* Photo — only in collapsed when not expanded (expanded has larger version) */}
          {!expanded && (
            <PersonPhoto src={displayImage} name={person.name_full} size="sm" />
          )}

          {/* Name + workplace + stats */}
          <div className="flex-1 min-w-0">
            <div className="font-bold text-stone-900 leading-tight text-[15px]">{person.name_full}</div>
            {wp && <div className="text-xs text-stone-500 mt-0.5 truncate">{wp}</div>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-stone-500">
              <span>{nPapers} corpus papers</span>
              {cites !== "0" && <span>{cites} citations</span>}
              {years && <span>{years}</span>}
              {person.stats?.primary_category && (
                <span className="text-[var(--accent-green)] font-semibold">{person.stats.primary_category}</span>
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

          {/* Photo + bio block */}
          {(displayImage || wd?.birth_year || wd?.birth_place) && (
            <div className="flex gap-3 items-start">
              <PersonPhoto src={displayImage} name={person.name_full} size="lg" />
              <div className="space-y-1 text-xs text-stone-600">
                {wd?.birth_year && (
                  <div>
                    <span className="text-stone-400 font-medium">Born: </span>
                    {wd.birth_year}
                    {wd.birth_place && `, ${wd.birth_place}`}
                  </div>
                )}
                {wd?.citizenships && wd.citizenships.length > 0 && (
                  <div>
                    <span className="text-stone-400 font-medium">Nationality: </span>
                    {wd.citizenships.join(", ")}
                  </div>
                )}
                {wd?.memberships && wd.memberships.length > 0 && (
                  <div>
                    <span className="text-stone-400 font-medium">Member: </span>
                    {wd.memberships.join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Full link strip */}
          {allLinks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {allLinks.map((l) => (
                <LinkPill key={l.label} href={l.href} label={l.label} />
              ))}
            </div>
          )}

          {/* Academic genealogy */}
          {(wd?.doctoral_advisors?.length > 0 || wd?.doctoral_students?.length > 0 ||
            wd?.educated_at?.length > 0) && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-bold tracking-widest uppercase text-stone-400">Academic background</div>
              <GenealogySection
                advisors={wd.doctoral_advisors}
                students={wd.doctoral_students}
                educatedAt={wd.educated_at}
              />
            </div>
          )}

          {/* Awards */}
          {wd?.awards && wd.awards.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-bold tracking-widest uppercase text-stone-400">Awards</div>
              <AwardsList awards={wd.awards} />
            </div>
          )}

          {/* Category breakdown */}
          {profile?.category_breakdown && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-bold tracking-widest uppercase text-stone-400">Research areas</div>
              <CategoryBreakdown cats={profile.category_breakdown} />
            </div>
          )}

          {/* All matched evidence papers */}
          {person.evidence && person.evidence.length > 3 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-bold tracking-widest uppercase text-stone-400">
                All matched papers
              </div>
              {person.evidence.map((ev, i) => (
                <EvidencePaper key={i} ev={ev} rank={i + 1} />
              ))}
            </div>
          )}

          {/* Full corpus papers — lazy-loaded expandable */}
          {nPapers > 0 && (
            <div>
              <button
                type="button"
                onClick={togglePapers}
                disabled={loadingPapers}
                className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline disabled:opacity-50"
              >
                {loadingPapers
                  ? "Loading papers…"
                  : showPapers
                  ? `Hide corpus papers ↑`
                  : `All ${nPapers} corpus papers ↓`}
              </button>

              {showPapers && papers && (
                <div className="mt-2 space-y-0">
                  {papers.in_corpus.length === 0 ? (
                    <div className="text-xs text-stone-400">No papers found.</div>
                  ) : (
                    papers.in_corpus.map((p, i) => (
                      <CorpusPaper key={i} paper={p} />
                    ))
                  )}
                  <a
                    href={ideasUrl(person.short_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-[var(--primary)] hover:underline mt-2"
                  >
                    Full profile on IDEAS →
                  </a>
                </div>
              )}
            </div>
          )}

          {/* IDEAS link when no full paper list shown */}
          {nPapers === 0 && (
            <a
              href={ideasUrl(person.short_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
            >
              Full profile on IDEAS →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
