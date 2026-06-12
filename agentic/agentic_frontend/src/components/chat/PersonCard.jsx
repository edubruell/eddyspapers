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

const EDUCATION_PREVIEW = 3;
const STUDENTS_PREVIEW = 8;

function GenealogySection({ advisors, students, educatedAt }) {
  const [showAllEdu, setShowAllEdu] = useState(false);
  const [showAllStudents, setShowAllStudents] = useState(false);

  const hasAdvisors = advisors && advisors.length > 0;
  const hasStudents = students && students.length > 0;
  const hasEducation = educatedAt && educatedAt.length > 0;
  if (!hasAdvisors && !hasStudents && !hasEducation) return null;

  const eduList = showAllEdu ? educatedAt : educatedAt?.slice(0, EDUCATION_PREVIEW);
  const studentList = showAllStudents ? students : students?.slice(0, STUDENTS_PREVIEW);

  return (
    <div className="space-y-1.5 text-xs">
      {hasEducation && (
        <div>
          <span className="font-medium text-stone-400">Educated at: </span>
          <span className="text-stone-700">{eduList.join(", ")}</span>
          {educatedAt.length > EDUCATION_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAllEdu((v) => !v)}
              className="ml-1 text-emerald-700 hover:underline"
            >
              {showAllEdu ? "less" : `+${educatedAt.length - EDUCATION_PREVIEW} more`}
            </button>
          )}
        </div>
      )}
      {hasAdvisors && (
        <div>
          <span className="font-medium text-stone-400">Doctoral advisor: </span>
          <span className="text-stone-700">{advisors.join(", ")}</span>
        </div>
      )}
      {hasStudents && (
        <div>
          <span className="font-medium text-stone-400">Doctoral students: </span>
          <span className="text-stone-700">
            {studentList.join(", ")}
            {students.length > STUDENTS_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllStudents((v) => !v)}
                className="ml-1 text-emerald-700 hover:underline"
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

function Section({ label, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-400">
        {label}
      </div>
      {children}
    </div>
  );
}

// Person result card — the people counterpart to PaperCard. Evidence rows are the
// matched papers that put this person in the results; the expandable section adds
// the Wikidata enrichment (genealogy, education, awards, external profiles).
export default function PersonCard({ person }) {
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const evidence = Array.isArray(person.evidence) ? person.evidence : [];
  const shown = showAllEvidence ? evidence : evidence.slice(0, 3);

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

  const links = [
    { href: person.url, label: "IDEAS" },
    { href: person.homepage || person.website, label: "Homepage" },
    {
      href: person.google_scholar_id
        ? `https://scholar.google.com/citations?user=${person.google_scholar_id}`
        : null,
      label: "Scholar",
    },
    { href: person.wikipedia_url, label: "Wikipedia" },
    { href: person.orcid ? `https://orcid.org/${person.orcid}` : null, label: "ORCID" },
    {
      href: person.ssrn_author_id
        ? `https://papers.ssrn.com/sol3/cf_dev/AbsByAuth.cfm?per_id=${person.ssrn_author_id}`
        : null,
      label: "SSRN",
    },
    {
      href: person.math_genealogy_id
        ? `https://www.genealogy.math.ndsu.nodak.edu/id.php?id=${person.math_genealogy_id}`
        : null,
      label: "MathGen",
    },
  ].filter((l) => l.href);

  const citizenships = person.citizenships || [];
  const memberships = person.memberships || [];
  const awards = person.awards || [];
  const hasBio =
    person.birth_year || person.birth_place || citizenships.length > 0 || memberships.length > 0;
  const hasGenealogy =
    (person.doctoral_advisors || []).length > 0 ||
    (person.doctoral_students || []).length > 0 ||
    (person.educated_at || []).length > 0;

  // Only offer "More" when the expansion would actually reveal something the
  // collapsed card doesn't already show (links beyond IDEAS/Homepage, or enrichment).
  const hasMore = hasBio || hasGenealogy || awards.length > 0 || links.length > 2;

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
            {evidence.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllEvidence((v) => !v)}
                className="mt-0.5 self-start text-[10px] text-stone-500 hover:text-stone-700 hover:underline"
              >
                {showAllEvidence ? "Fewer matches" : `All ${evidence.length} matches`}
              </button>
            )}
          </div>
        )}

        {expanded && (
          <div className="mt-1 flex flex-col gap-2 border-t border-stone-200 pt-2">
            {hasBio && (
              <div className="space-y-0.5 text-xs text-stone-600">
                {(person.birth_year || person.birth_place) && (
                  <div>
                    <span className="font-medium text-stone-400">Born: </span>
                    {[person.birth_year, person.birth_place].filter(Boolean).join(", ")}
                  </div>
                )}
                {citizenships.length > 0 && (
                  <div>
                    <span className="font-medium text-stone-400">Nationality: </span>
                    {citizenships.join(", ")}
                  </div>
                )}
                {memberships.length > 0 && (
                  <div>
                    <span className="font-medium text-stone-400">Member: </span>
                    {memberships.join(", ")}
                  </div>
                )}
              </div>
            )}

            {hasGenealogy && (
              <Section label="Academic background">
                <GenealogySection
                  advisors={person.doctoral_advisors}
                  students={person.doctoral_students}
                  educatedAt={person.educated_at}
                />
              </Section>
            )}

            {awards.length > 0 && (
              <Section label="Awards">
                <ul className="space-y-0.5">
                  {awards.map((a, i) => (
                    <li key={i} className="text-xs text-stone-700">
                      {a}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {links.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {links.map((l) => (
                  <LinkPill key={l.label} href={l.href} label={l.label} />
                ))}
              </div>
            )}
          </div>
        )}

        <footer className="mt-1 flex flex-wrap items-center gap-1.5">
          <LinkPill href={person.url} label="IDEAS" />
          <LinkPill href={person.homepage || person.website} label="Homepage" />
          {hasMore && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-0.5 text-[10px] text-stone-700 hover:bg-stone-100"
            >
              {expanded ? "Less ↑" : "More ↓"}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}
