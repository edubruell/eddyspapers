import { describe, it, expect } from "vitest";
import { searchPart, SEARCH_PARTS } from "../../src/agent/parts.js";
import type { SearchBundle } from "../../src/agent/bundle.js";
import type { Paper, Section } from "../../src/agent/types.js";

// The slicer behind handle delivery. Pagination is the whole point — a part that silently
// returned everything would put us straight back over the client's per-result cap.

const paper = (n: number): Paper => ({
  handle: `repec:x:p:${n}`,
  title: `Paper ${n}`,
  authors: ["Doe, J."],
  year: 2000 + n,
  journal: "Journal of Things",
  category: "Micro",
  url: `https://x/${n}`,
  doi: null,
  abstract: `Abstract ${n}`,
  bibtex: `@article{p${n},}`,
});

const section: Section = {
  id: "sem-1",
  title: "Semantic",
  mode: "semantic",
  n_total: 3,
  n_shown: 3,
  rows: [1, 2, 3].map((n) => ({ handle: `repec:x:p:${n}`, rank: n, similarity: 0.1 * n })),
};

const bundle: SearchBundle = {
  search_id: "abc123",
  synthesis_md: "",
  bibtex: "@article{p1,}\n\n@article{p2,}",
  papers_csv: "handle,title\nrepec:x:p:1,Paper 1\nrepec:x:p:2,Paper 2\nrepec:x:p:3,Paper 3",
  papers: Object.fromEntries([1, 2, 3].map((n) => [`repec:x:p:${n}`, paper(n)])),
  persons: {},
  sections: [section],
  strategy: "Sweep.",
  script: "handles <- c()",
  resource_uri: "agenticsearch://searches/abc123",
  slug: "r",
};

describe("searchPart", () => {
  it("serves every declared part without throwing", () => {
    for (const part of SEARCH_PARTS) {
      expect(searchPart(bundle, part).data.part).toBe(part);
    }
  });

  it("paginates papers and reports next_offset until exhausted", () => {
    const first = searchPart(bundle, "papers", { limit: 2 }).data as {
      papers: Paper[];
      n_total: number;
      next_offset: number | null;
    };
    expect(first.papers.map((p) => p.handle)).toEqual(["repec:x:p:1", "repec:x:p:2"]);
    expect(first.n_total).toBe(3);
    expect(first.next_offset).toBe(2);

    const second = searchPart(bundle, "papers", { offset: first.next_offset!, limit: 2 }).data as {
      papers: Paper[];
      next_offset: number | null;
    };
    expect(second.papers.map((p) => p.handle)).toEqual(["repec:x:p:3"]);
    expect(second.next_offset).toBeNull();
  });

  it("repeats the CSV header on every page so a page is a valid CSV on its own", () => {
    const page = searchPart(bundle, "csv", { offset: 1, limit: 1 });
    expect(page.text.split("\n")[0]).toBe("handle,title");
    expect(page.text.split("\n")[1]).toBe("repec:x:p:2,Paper 2");
    expect((page.data as { next_offset: number | null }).next_offset).toBe(2);
  });

  it("returns one section by id and a not-found (with the id list) otherwise", () => {
    expect((searchPart(bundle, "sections", { sectionId: "sem-1" }).data as { section: Section }).section.id).toBe(
      "sem-1",
    );
    const miss = searchPart(bundle, "sections", { sectionId: "nope" }).data as {
      error: string;
      sections: { id: string }[];
    };
    expect(miss.error).toMatch(/section not found/i);
    expect(miss.sections.map((s) => s.id)).toEqual(["sem-1"]);
  });

  it("clamps a nonsense window instead of erroring", () => {
    const d = searchPart(bundle, "papers", { offset: -5, limit: 10_000 }).data as {
      offset: number;
      limit: number;
      papers: Paper[];
    };
    expect(d.offset).toBe(0);
    expect(d.limit).toBe(500);
    expect(d.papers).toHaveLength(3);
  });

  it("overview carries counts and the section map but no rows", () => {
    const d = searchPart(bundle, "overview").data as Record<string, unknown>;
    expect(d.n_papers).toBe(3);
    expect(d.has_synthesis).toBe(false);
    expect(JSON.stringify(d)).not.toContain("Abstract 1");
  });
});
