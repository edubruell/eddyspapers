import type { Paper, Section } from "./types.js";
import type { SearchBundle } from "./bundle.js";

// Handle-plus-fetch delivery (§7.5). A completed run's artifacts are far larger than a
// tool result should be — a 40-paper script-only run measured 133,641 chars and overflowed
// a real client's per-result cap — so lit_search can hand back a handle (search_id +
// resource_uri) and let the caller pull the pieces it actually needs. This module is the
// single slicer behind fetch_search; the agenticsearch://searches resources expose the same
// cuts by URI, so a part means the same thing whichever face a client can reach.

export const SEARCH_PARTS = ["overview", "script", "bibtex", "csv", "papers", "sections", "synthesis"] as const;
export type SearchPart = (typeof SEARCH_PARTS)[number];

export const PART_DOCS: Record<SearchPart, string> = {
  overview: "Counts, the strategy, and a per-section summary — no rows. Free orientation before fetching.",
  script: "The R search script that produced the run, verbatim.",
  bibtex: "The deduped .bib bundle. Write it straight to disk.",
  csv: "The flat one-row-per-paper CSV (includes abstracts — paginate with offset/limit).",
  papers: "Full paper records, ordered, as an array (includes abstracts — paginate with offset/limit).",
  sections: "Section row sets; pass section_id for one section instead of all.",
  synthesis: "The server-written review, if this run was a synthesize=true run (empty otherwise).",
};

// Rows-per-page default for the two parts that carry abstracts. Deliberately small: the
// whole point of fetching is to stay under the caller's per-result cap.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;

export interface PartResult {
  text: string;
  data: Record<string, unknown>;
}

export interface PartOptions {
  offset?: number;
  limit?: number;
  sectionId?: string;
}

interface Window {
  offset: number;
  limit: number;
}

function windowOf(opts: PartOptions): Window {
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)));
  return { offset, limit };
}

// Page metadata is uniform across the paginated parts so a caller can loop on next_offset
// without knowing which part it is walking.
function page<T>(items: T[], w: Window): { slice: T[]; meta: Record<string, unknown> } {
  const slice = items.slice(w.offset, w.offset + w.limit);
  const end = w.offset + slice.length;
  return {
    slice,
    meta: { offset: w.offset, limit: w.limit, n_total: items.length, next_offset: end < items.length ? end : null },
  };
}

export function sectionSummaries(sections: Section[]): Record<string, unknown>[] {
  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    mode: s.mode,
    kind: s.kind ?? "papers",
    n_total: s.n_total,
    n_shown: s.n_shown,
  }));
}

export function searchPart(bundle: SearchBundle, part: SearchPart, opts: PartOptions = {}): PartResult {
  const w = windowOf(opts);
  const base = { search_id: bundle.search_id, part };

  switch (part) {
    case "overview": {
      const data = {
        ...base,
        strategy: bundle.strategy,
        n_papers: Object.keys(bundle.papers).length,
        n_persons: Object.keys(bundle.persons).length,
        has_synthesis: bundle.synthesis_md.trim().length > 0,
        sections: sectionSummaries(bundle.sections),
        resource_uri: bundle.resource_uri,
        slug: bundle.slug,
      };
      return { text: JSON.stringify(data, null, 2), data };
    }

    case "script":
    case "bibtex":
    case "synthesis": {
      const text = part === "script" ? bundle.script : part === "bibtex" ? bundle.bibtex : bundle.synthesis_md;
      return { text, data: { ...base, text } };
    }

    case "csv": {
      // The header always rides along, so any page is a valid CSV file on its own.
      const [header = "", ...rows] = bundle.papers_csv.split("\n");
      const { slice, meta } = page(rows, w);
      const text = [header, ...slice].join("\n");
      return { text, data: { ...base, ...meta, csv: text } };
    }

    case "papers": {
      const { slice, meta } = page(Object.values(bundle.papers) as Paper[], w);
      const data = { ...base, ...meta, papers: slice };
      return { text: JSON.stringify(data, null, 2), data };
    }

    case "sections": {
      if (opts.sectionId != null) {
        const section = bundle.sections.find((s) => s.id === opts.sectionId);
        const data = section
          ? { ...base, section }
          : { ...base, error: `section not found: ${opts.sectionId}`, sections: sectionSummaries(bundle.sections) };
        return { text: JSON.stringify(data, null, 2), data };
      }
      const data = { ...base, n_total: bundle.sections.length, sections: bundle.sections };
      return { text: JSON.stringify(data, null, 2), data };
    }
  }
}
