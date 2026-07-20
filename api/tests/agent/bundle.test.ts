import { describe, it, expect } from "vitest";
import { buildBundle, collectSynthesis, slugify } from "../../src/agent/bundle.js";
import type { Paper, Person, Section, StreamEvent } from "../../src/agent/types.js";

// Unit tests for the run-events → §7.5 bundle reducer. Pure over StreamEvent[], so these
// synthesise event streams directly rather than running the pipeline.

let seq = 0;
const ev = (e: Omit<StreamEvent, "seq">): StreamEvent => ({ ...e, seq: seq++ } as StreamEvent);

function paper(handle: string, extra: Partial<Paper> = {}): Paper {
  return {
    handle,
    title: `Title ${handle}`,
    authors: ["Smith, A.", "Jones, B."],
    year: 2020,
    journal: "American Economic Review",
    category: "Top 5 Journals",
    url: `https://x/${handle}`,
    abstract: "An abstract.",
    bibtex: `@article{${handle},}`,
    ...extra,
  };
}

function section(id: string, rows: Section["rows"], extra: Partial<Section> = {}): Section {
  return {
    id,
    title: `Section ${id}`,
    mode: "semantic",
    n_total: rows.length,
    n_shown: rows.length,
    rows,
    ...extra,
  };
}

describe("slugify", () => {
  it("keeps the first six significant words, lowercased and dash-joined", () => {
    expect(slugify("Causal Effects of Minimum Wage on Youth Employment in the US")).toBe(
      "causal-effects-of-minimum-wage-on",
    );
  });
  it("strips punctuation and falls back to 'search' when empty", () => {
    expect(slugify("!!! ??? ")).toBe("search");
    expect(slugify("R&D spillovers")).toBe("rd-spillovers");
  });
});

describe("collectSynthesis", () => {
  it("concatenates synthesis deltas in order", () => {
    const events = [
      ev({ type: "synthesis", delta: "## Findings\n" }),
      ev({ type: "synthesis", delta: "Body." }),
    ];
    expect(collectSynthesis(events)).toBe("## Findings\nBody.");
  });
});

describe("buildBundle", () => {
  const events: StreamEvent[] = [
    ev({ type: "strategy", strategy: "Sweep top-5 then working papers." }),
    ev({ type: "script", delta: "all_handles <- character(0)" }),
    ev({ type: "paper", paper: paper("repec:a", { stats: { cites_internal: 3, cites_total: 40, percentile: 92 } }) }),
    ev({ type: "paper", paper: paper("repec:b") }),
    ev({ type: "section", section: section("sem-1", [
      { handle: "repec:a", rank: 1, similarity: 0.21 },
      { handle: "repec:b", rank: 2, similarity: 0.44 },
    ]) }),
    ev({ type: "section", section: section("kw-1", [{ handle: "repec:a", rank: 1 }], { mode: "keyword" }) }),
    ev({ type: "bibtex", entries: 2, bibtex: "@article{repec:a,}\n@article{repec:b,}" }),
    ev({ type: "synthesis", delta: "## Review\n" }),
    ev({ type: "synthesis", delta: "Prose." }),
    ev({ type: "done", ms_total: 1234 }),
  ];

  it("assembles synthesis, bibtex, papers, sections, script, and the resource uri", () => {
    const b = buildBundle("abc123", "Minimum wage employment effects", events);
    expect(b.search_id).toBe("abc123");
    expect(b.synthesis_md).toBe("## Review\nProse.");
    expect(b.strategy).toBe("Sweep top-5 then working papers.");
    expect(b.script).toBe("all_handles <- character(0)");
    expect(Object.keys(b.papers).sort()).toEqual(["repec:a", "repec:b"]);
    expect(b.sections).toHaveLength(2);
    expect(b.bibtex).toContain("@article{repec:a,}");
    expect(b.resource_uri).toBe("agenticsearch://searches/abc123");
    expect(b.suggested_paths.report).toBe("local_context/notes/literature/lit_minimum-wage-employment-effects.md");
    expect(b.suggested_paths.bibtex).toMatch(/\.bib$/);
    expect(b.suggested_paths.csv).toMatch(/\.csv$/);
  });

  it("builds a CSV with the §7.5 columns, best similarity, pipe-joined sections, and stats", () => {
    const b = buildBundle("abc123", "brief", events);
    const lines = b.papers_csv.split("\n");
    expect(lines[0]).toBe(
      "handle,title,authors,year,journal,category,url,abstract,max_similarity,sections,cites_internal,cites_total,percentile",
    );
    const rowA = lines.find((l) => l.startsWith("repec:a"))!;
    const cols = rowA.split(",");
    // authors joined with ", " → the cell is quoted, so naive split breaks; assert on the raw row instead.
    expect(rowA).toContain('"Smith, A., Jones, B."');
    expect(rowA).toContain("0.21"); // best (lowest) similarity across sem-1 (0.21) — kw-1 has none
    expect(rowA).toContain("sem-1|kw-1"); // appeared in both sections
    expect(rowA).toContain("92"); // percentile from stats
    void cols;
    const rowB = lines.find((l) => l.startsWith("repec:b"))!;
    expect(rowB).toContain("0.44");
    expect(rowB.endsWith(",,,")).toBe(true); // no stats → trailing empty cites/percentile cells
  });

  it("escapes CSV cells containing commas, quotes, and newlines", () => {
    const nasty = paper("repec:q", { title: 'A "quoted", comma\ntitle', abstract: "line1\nline2" });
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: nasty }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    const dataLine = b.papers_csv.split("\n").slice(1).join("\n");
    expect(dataLine).toContain('"A ""quoted"", comma\ntitle"');
    expect(dataLine).toContain('"line1\nline2"');
  });

  it("falls back to per-paper bibtex when no bibtex event was emitted", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("repec:a") }),
      ev({ type: "paper", paper: paper("repec:b") }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(b.bibtex).toBe("@article{repec:a,}\n\n@article{repec:b,}");
  });

  it("collects persons into the structured map and keeps CSV paper-only", () => {
    const person: Person = {
      short_id: "pab1",
      name: "Ada Byron",
      affiliation: null,
      homepage: null,
      image_url: null,
      wikipedia_url: null,
      orcid: null,
      url: "https://authors/pab1",
      n_works: 10,
      citations: 100,
      first_year: 2000,
      last_year: 2022,
      primary_category: "Top 5 Journals",
      n_matched: 2,
      birth_year: null,
      birth_place: null,
      citizenships: [],
      educated_at: [],
      doctoral_advisors: [],
      doctoral_students: [],
      memberships: [],
      awards: [],
      google_scholar_id: null,
      ssrn_author_id: null,
      math_genealogy_id: null,
      website: null,
      evidence: [],
    };
    const b = buildBundle("id", "brief", [
      ev({ type: "person", person }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(Object.keys(b.persons)).toEqual(["pab1"]);
    expect(b.papers_csv.split("\n")).toHaveLength(1); // header only — no paper rows
  });

  it("prefers the last bibtex/script/strategy event (refine re-emits)", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "script", delta: "round1" }),
      ev({ type: "bibtex", entries: 1, bibtex: "round1bib" }),
      ev({ type: "strategy", strategy: "round1 plan" }),
      ev({ type: "script", delta: "round2" }),
      ev({ type: "bibtex", entries: 2, bibtex: "round2bib" }),
      ev({ type: "strategy", strategy: "round2 plan" }),
      ev({ type: "paper", paper: paper("a") }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(b.script).toBe("round2");
    expect(b.bibtex).toBe("round2bib");
    expect(b.strategy).toBe("round2 plan");
  });
});

// ── Additional edge cases (Phase 3 test extension) ─────────────────────────────────────
describe("buildBundle — max_similarity across sections", () => {
  // Minimal RFC4180 field parser: splits a CSV logical row into cells, honouring quoting
  // (so the quoted "Smith, A., Jones, B." authors cell isn't mis-split on its commas).
  function parseCsvRow(row: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (inQ) {
        if (c === '"') {
          if (row[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  // A logical row may span physical lines (a quoted newline). Rejoin the CSV, then split on
  // the header + each handle prefix. For these tests handles never contain a newline, so
  // finding the first cell (handle) per logical row is enough.
  const rowsOf = (csv: string): string[][] => {
    // Split into logical rows by tracking quote parity across physical lines.
    const rows: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of csv) {
      if (ch === '"') inQ = !inQ;
      if (ch === "\n" && !inQ) { rows.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) rows.push(cur);
    return rows.map(parseCsvRow);
  };
  const cell = (csv: string, handle: string, col: string) => {
    const all = rowsOf(csv);
    const header = all[0];
    const idx = header.indexOf(col);
    const row = all.find((r) => r[0] === handle);
    return row?.[idx];
  };

  it("takes the MIN similarity when a handle appears in multiple sections with different scores", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h") }),
      ev({ type: "section", section: section("s1", [{ handle: "h", rank: 1, similarity: 0.6 }]) }),
      ev({ type: "section", section: section("s2", [{ handle: "h", rank: 1, similarity: 0.3 }]) }),
      ev({ type: "section", section: section("s3", [{ handle: "h", rank: 5, similarity: 0.9 }]) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(cell(b.papers_csv, "h", "max_similarity")).toBe("0.3");
    expect(cell(b.papers_csv, "h", "sections")).toBe("s1|s2|s3");
  });

  it("uses the similarity from a section that HAS it even when another section lacks it", () => {
    // handle appears in a semantic section (has similarity) and a keyword section (none).
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h") }),
      ev({ type: "section", section: section("kw", [{ handle: "h", rank: 1 }], { mode: "keyword" }) }),
      ev({ type: "section", section: section("sem", [{ handle: "h", rank: 1, similarity: 0.42 }]) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(cell(b.papers_csv, "h", "max_similarity")).toBe("0.42");
  });

  it("leaves max_similarity empty for a paper present in NO section", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("orphan") }),
      ev({ type: "section", section: section("s1", [{ handle: "other", rank: 1, similarity: 0.1 }]) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    // orphan appears as a paper but is in no section row
    expect(cell(b.papers_csv, "orphan", "max_similarity")).toBe("");
    expect(cell(b.papers_csv, "orphan", "sections")).toBe("");
  });

  it("keeps max_similarity empty when the paper's only sections are keyword/SQL (no similarity)", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h") }),
      ev({ type: "section", section: section("kw1", [{ handle: "h", rank: 1 }], { mode: "keyword" }) }),
      ev({ type: "section", section: section("kw2", [{ handle: "h", rank: 2 }], { mode: "journal_scan" }) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(cell(b.papers_csv, "h", "max_similarity")).toBe("");
    expect(cell(b.papers_csv, "h", "sections")).toBe("kw1|kw2");
  });

  it("treats similarity 0 as a real value, not a missing one", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h") }),
      ev({ type: "section", section: section("s1", [{ handle: "h", rank: 1, similarity: 0 }]) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(cell(b.papers_csv, "h", "max_similarity")).toBe("0");
  });
});

describe("buildBundle — CSV numeric fields and encoding", () => {
  it("emits year and percentile as bare (unquoted) numbers", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h", { year: 2019, stats: { cites_internal: 1, cites_total: 2, percentile: 77 } }) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    const row = b.papers_csv.split("\n")[1];
    // no quoting around plain numbers
    expect(row).not.toMatch(/"2019"/);
    expect(row).not.toMatch(/"77"/);
    expect(row.split(",")).toContain("2019");
    expect(row.split(",")).toContain("77");
  });

  it("preserves unicode in title and abstract without corruption", () => {
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("h", { title: "Größe, Inflación und 日本語", abstract: "café — naïve" }) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    // title has a comma → the whole cell is quoted, but the unicode text is intact inside it.
    expect(b.papers_csv).toContain('"Größe, Inflación und 日本語"');
    expect(b.papers_csv).toContain("Inflación");
    expect(b.papers_csv).toContain("日本語");
    expect(b.papers_csv).toContain("café — naïve");
  });
});

describe("buildBundle — degenerate event streams", () => {
  it("returns an all-empty bundle for zero events (header-only CSV)", () => {
    const b = buildBundle("empty", "some brief here", []);
    expect(b.synthesis_md).toBe("");
    expect(b.strategy).toBe("");
    expect(b.script).toBe("");
    expect(b.bibtex).toBe("");
    expect(Object.keys(b.papers)).toEqual([]);
    expect(Object.keys(b.persons)).toEqual([]);
    expect(b.sections).toEqual([]);
    expect(b.papers_csv.split("\n")).toHaveLength(1); // header only
    expect(b.papers_csv).toMatch(/^handle,title,authors/);
  });

  it("builds a person-only run with a header-only CSV and empty bibtex", () => {
    const person: Person = {
      short_id: "pxy",
      name: "Rosa Luxemburg",
      affiliation: "ZEW",
      homepage: null,
      image_url: null,
      wikipedia_url: null,
      orcid: null,
      url: "https://authors/pxy",
      n_works: 5,
      citations: 12,
      first_year: 1990,
      last_year: 2001,
      primary_category: "Labour",
      n_matched: 3,
      birth_year: null,
      birth_place: null,
      citizenships: [],
      educated_at: [],
      doctoral_advisors: [],
      doctoral_students: [],
      memberships: [],
      awards: [],
      google_scholar_id: null,
      ssrn_author_id: null,
      math_genealogy_id: null,
      website: null,
      evidence: [],
    };
    const b = buildBundle("id", "who studies X", [
      ev({ type: "person", person }),
      ev({ type: "section", section: { ...section("ppl", [{ handle: "pxy", rank: 1 }]), kind: "persons", mode: "person" } }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    expect(Object.keys(b.persons)).toEqual(["pxy"]);
    expect(Object.keys(b.papers)).toEqual([]);
    expect(b.papers_csv.split("\n")).toHaveLength(1); // header only — persons never become paper rows
    expect(b.bibtex).toBe(""); // no papers → nothing to assemble
    expect(b.sections).toHaveLength(1);
  });

  it("emits a section that references a handle with no matching paper without crashing", () => {
    // section row points at a handle never emitted as a paper — the CSV must not gain a row for it
    const b = buildBundle("id", "brief", [
      ev({ type: "paper", paper: paper("known") }),
      ev({ type: "section", section: section("s1", [
        { handle: "known", rank: 1, similarity: 0.2 },
        { handle: "ghost", rank: 2, similarity: 0.1 },
      ]) }),
      ev({ type: "done", ms_total: 1 }),
    ]);
    const handles = b.papers_csv.split("\n").slice(1).map((l) => l.split(",")[0]);
    expect(handles).toContain("known");
    expect(handles).not.toContain("ghost"); // no paper record → no CSV row
  });
});
