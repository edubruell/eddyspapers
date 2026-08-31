import type { Paper, Person, Section, StreamEvent } from "./types.js";

// Reduces a completed run's event stream into the three-artifact bundle the MCP
// `lit_search` tool returns (01_design.md §7.5) and the agenticsearch://searches
// resources serve (§7.6). Pure over StreamEvent[] so it works identically on a live
// run's collected events and on a run replayed from the persistent store — the same
// property the web share-link reducer relies on.

export interface SuggestedPaths {
  report: string;
  bibtex: string;
  csv: string;
}

export interface SearchBundle {
  search_id: string;
  synthesis_md: string;
  bibtex: string;
  papers_csv: string;
  papers: Record<string, Paper>;
  persons: Record<string, Person>;
  sections: Section[];
  strategy: string;
  script: string;
  resource_uri: string;
  suggested_paths: SuggestedPaths;
}

// First ~6 significant words of the brief → a filesystem-safe slug for suggested_paths.
export function slugify(brief: string): string {
  const slug = brief
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return slug || "search";
}

export function collectSynthesis(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: "synthesis" }> => e.type === "synthesis")
    .map((e) => e.delta)
    .join("");
}

const CSV_COLUMNS = [
  "handle",
  "title",
  "authors",
  "year",
  "journal",
  "category",
  "url",
  "abstract",
  "max_similarity",
  "sections",
  "cites_internal",
  "cites_total",
  "percentile",
  "oa_cites",
  "fwci",
  "retracted",
  "oa_url",
] as const;

function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One flat row per paper (§7.5). max_similarity is the best (lowest) cosine distance the
// paper achieved in any section it appeared in; empty if it only came from a keyword/SQL
// section. `sections` is the pipe-joined list of section ids it appeared in.
function buildCsv(papers: Record<string, Paper>, sections: Section[]): string {
  const bestSim = new Map<string, number>();
  const sectionsFor = new Map<string, string[]>();
  for (const section of sections) {
    for (const row of section.rows) {
      const ids = sectionsFor.get(row.handle) ?? [];
      ids.push(section.id);
      sectionsFor.set(row.handle, ids);
      if (typeof row.similarity === "number") {
        const prev = bestSim.get(row.handle);
        if (prev == null || row.similarity < prev) bestSim.set(row.handle, row.similarity);
      }
    }
  }

  const header = CSV_COLUMNS.join(",");
  const rows = Object.values(papers).map((p) => {
    const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      handle: p.handle,
      title: p.title,
      authors: p.authors.join(", "),
      year: p.year,
      journal: p.journal,
      category: p.category,
      url: p.url,
      abstract: p.abstract ?? "",
      max_similarity: bestSim.get(p.handle) ?? "",
      sections: (sectionsFor.get(p.handle) ?? []).join("|"),
      cites_internal: p.stats?.cites_internal ?? "",
      cites_total: p.stats?.cites_total ?? "",
      percentile: p.stats?.percentile ?? "",
      oa_cites: p.openalex?.oa_cited_by_count ?? "",
      fwci: p.openalex?.fwci ?? "",
      // Flag-and-keep: retracted papers stay in the deliverable, marked, never silently dropped.
      retracted: p.openalex?.is_retracted ? "RETRACTED" : "",
      oa_url: p.openalex?.oa_url ?? "",
    };
    return CSV_COLUMNS.map((c) => csvCell(cells[c])).join(",");
  });
  return [header, ...rows].join("\n");
}

export type Delivery = "inline" | "handle";

// One sentence telling the caller where the artifacts it does NOT have in hand live. Under
// handle delivery that is the difference between a usable result and a dead end, so it names
// the tool and the resource URI rather than gesturing at "the resource".
export function whereTheRestIs(bundle: SearchBundle, delivery: Delivery): string {
  return delivery === "inline"
    ? "Full rows, BibTeX and CSV are in structuredContent; the R script that produced them is in `script`."
    : `The full artifacts were NOT inlined (too large). Fetch them with ` +
        `fetch_search(search_id="${bundle.search_id}", part="bibtex"|"csv"|"papers"|"script"), or read ` +
        `${bundle.resource_uri}/bibtex etc. The list below is complete — you can write the review from it ` +
        `without fetching anything.`;
}

// Script-only mode returns no LLM-written review, so the tool's text block carries this
// instead: the strategy, the section structure the script produced, and every retrieved
// paper as a citable line. Deliberately mechanical — the calling agent does the writing.
//
// It is also the whole deliverable under handle delivery (parts.ts): the digest carries
// enough per paper (authors, year, title, journal, handle, cites, doi) to write a review
// without fetching anything, which is why it never inlines abstracts.
export function resultsDigest(bundle: SearchBundle, delivery: Delivery = "inline"): string {
  const paperLine = (handle: string, i: number): string => {
    const p = bundle.papers[handle];
    if (!p) return `${i + 1}. ${handle}`;
    const authors = p.authors.length ? p.authors.join("; ") : "unknown author";
    const flags = [
      p.openalex?.is_retracted ? "**RETRACTED**" : null,
      p.stats?.cites_total != null ? `${p.stats.cites_total} cites` : null,
      p.doi ? `doi:${p.doi}` : null,
    ].filter(Boolean);
    return (
      `${i + 1}. ${authors} (${p.year}). *${p.title}*. ${p.journal}. \`${p.handle}\`` +
      (flags.length ? ` — ${flags.join(", ")}` : "")
    );
  };

  const personLine = (shortId: string, i: number): string => {
    const person = bundle.persons[shortId];
    if (!person) return `${i + 1}. ${shortId}`;
    const bits = [person.affiliation, person.n_works != null ? `${person.n_works} works` : null].filter(Boolean);
    return `${i + 1}. ${person.name} \`${person.short_id}\`` + (bits.length ? ` — ${bits.join(", ")}` : "");
  };

  const sectionBlocks = bundle.sections.map((section) => {
    const lines = section.rows.map((row, i) =>
      section.kind === "persons" ? personLine(row.handle, i) : paperLine(row.handle, i),
    );
    const counts = `${section.n_shown} of ${section.n_total}`;
    return [`### ${section.title}`, `_${section.mode} · ${counts}_`, "", ...lines].join("\n");
  });

  const paperCount = Object.keys(bundle.papers).length;
  const personCount = Object.keys(bundle.persons).length;
  const totals = [
    paperCount ? `${paperCount} papers` : null,
    personCount ? `${personCount} people` : null,
  ].filter(Boolean).join(", ") || "no results";

  return [
    `## Search results (script-only — no synthesis was written)`,
    "",
    bundle.strategy ? `**Strategy.** ${bundle.strategy}` : null,
    "",
    `**Retrieved.** ${totals} across ${bundle.sections.length} section(s). ` + whereTheRestIs(bundle, delivery),
    "",
    ...sectionBlocks,
  ]
    .filter((b) => b !== null)
    .join("\n")
    .trim();
}

export function buildBundle(searchId: string, brief: string, events: StreamEvent[]): SearchBundle {
  const papers: Record<string, Paper> = {};
  const persons: Record<string, Person> = {};
  const sections: Section[] = [];
  let bibtex = "";
  let strategy = "";
  let script = "";

  for (const e of events) {
    switch (e.type) {
      case "paper":
        papers[e.paper.handle] = e.paper;
        break;
      case "person":
        persons[e.person.short_id] = e.person;
        break;
      case "section":
        sections.push(e.section);
        break;
      case "bibtex":
        bibtex = e.bibtex; // last bibtex event wins (refine re-emits the consolidated bundle)
        break;
      case "strategy":
        strategy = e.strategy; // last strategy wins (refine may re-derive)
        break;
      case "script":
        script = e.delta; // script events carry the full script; last wins
        break;
      default:
        break;
    }
  }

  // Fallback: assemble the .bib from per-paper entries if no bibtex event was emitted.
  if (!bibtex) {
    bibtex = Object.values(papers)
      .map((p) => p.bibtex)
      .filter(Boolean)
      .join("\n\n");
  }

  const slug = slugify(brief);
  return {
    search_id: searchId,
    synthesis_md: collectSynthesis(events),
    bibtex,
    papers_csv: buildCsv(papers, sections),
    papers,
    persons,
    sections,
    strategy,
    script,
    resource_uri: `agenticsearch://searches/${searchId}`,
    suggested_paths: {
      report: `local_context/notes/literature/lit_${slug}.md`,
      bibtex: `local_context/search_related/results_${slug}.bib`,
      csv: `local_context/search_related/results_${slug}.csv`,
    },
  };
}
