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
    };
    return CSV_COLUMNS.map((c) => csvCell(cells[c])).join(",");
  });
  return [header, ...rows].join("\n");
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
