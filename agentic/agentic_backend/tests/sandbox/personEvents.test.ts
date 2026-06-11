import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { parseRawEvent } from "../../src/sandbox/events.js";

// Schema coverage for the EconPeople integration: person / person_section raw events,
// the section `mode` field, and the progress current/total null fix. R emits explicit
// nulls (jsonlite, null = "null"), so every optional field must tolerate null without
// dropping the event — the same regression class as paperNullTolerance.test.ts.

// Captured from a real `run.R` person-finder run against articles_agentic.duckdb (2026-06-11).
const CAPTURE = new URL("../fixtures/person_events.jsonl", import.meta.url).pathname;

describe("person event null tolerance", () => {
  it("accepts a fully-populated person (real captured shape)", () => {
    const e = parseRawEvent({
      type: "person",
      short_id: "pne16",
      name: "David Neumark",
      affiliation: "University of California-Irvine / Department of Economics",
      homepage: "",
      image_url: null,
      wikipedia_url: "https://en.wikipedia.org/wiki/David_Neumark",
      orcid: "0000-0002-7681-1884",
      url: "https://ideas.repec.org/e/pne16.html",
      n_works: 168,
      citations: 6719,
      first_year: 1995,
      last_year: 2026,
      primary_category: "Working Paper Series",
      n_matched: 27,
      evidence: [
        {
          handle: "repec:uwp:jhriss:v:37:y:2002:i:1:p:35-62",
          title: "State-Level Estimates of Minimum Wage Effects",
          journal: "Journal of Human Resources",
          year: 2002,
          score: 0.8863,
        },
      ],
    });
    expect(e).not.toBeNull();
    if (e?.type === "person") {
      expect(e.short_id).toBe("pne16");
      expect(e.evidence).toHaveLength(1);
      expect(e.evidence?.[0].score).toBeCloseTo(0.8863);
    }
  });

  it("accepts a person with every optional field explicitly null", () => {
    const e = parseRawEvent({
      type: "person",
      short_id: "pxx1",
      name: null,
      affiliation: null,
      homepage: null,
      image_url: null,
      wikipedia_url: null,
      orcid: null,
      url: "https://ideas.repec.org/e/pxx1.html",
      n_works: null,
      citations: null,
      first_year: null,
      last_year: null,
      primary_category: null,
      n_matched: null,
      evidence: null,
    });
    expect(e).not.toBeNull();
    if (e?.type === "person") {
      expect(e.name).toBe(""); // coerced, never undefined
      expect(e.affiliation ?? null).toBeNull();
      expect(e.n_works ?? null).toBeNull();
      expect(e.evidence ?? null).toBeNull();
    }
  });

  it("accepts a person with optional fields entirely absent", () => {
    const e = parseRawEvent({
      type: "person",
      short_id: "pxx2",
      url: "https://ideas.repec.org/e/pxx2.html",
    });
    expect(e).not.toBeNull();
    if (e?.type === "person") expect(e.name).toBe("");
  });

  it("rejects a person missing the required short_id", () => {
    expect(
      parseRawEvent({ type: "person", name: "X", url: "https://e/p" }),
    ).toBeNull();
  });

  it("rejects a person missing the required url", () => {
    expect(parseRawEvent({ type: "person", short_id: "p1" })).toBeNull();
  });

  it("coerces null evidence fields instead of dropping the person", () => {
    const e = parseRawEvent({
      type: "person",
      short_id: "pxx3",
      url: "https://e/p3",
      evidence: [{ handle: "repec:x:1", title: null, journal: null, year: null, score: null }],
    });
    expect(e).not.toBeNull();
    if (e?.type === "person") {
      const ev = e.evidence?.[0];
      expect(ev?.title).toBe("");
      expect(ev?.journal).toBe("");
      expect(ev?.year).toBe(0);
      expect(ev?.score).toBeUndefined();
    }
  });

  it("rejects an evidence row missing its handle (drops the whole person)", () => {
    const e = parseRawEvent({
      type: "person",
      short_id: "pxx4",
      url: "https://e/p4",
      evidence: [{ title: "no handle" }],
    });
    expect(e).toBeNull();
  });
});

describe("person_section event", () => {
  it("parses a captured person_section (note: null)", () => {
    const e = parseRawEvent({
      type: "person_section",
      title: "Researchers active on minimum wages",
      short_ids: ["pne16", "pcl99", "pdu263"],
      note: null,
    });
    expect(e).not.toBeNull();
    if (e?.type === "person_section") {
      expect(e.short_ids).toEqual(["pne16", "pcl99", "pdu263"]);
      expect(e.note ?? null).toBeNull();
    }
  });

  it("parses a single-element short_ids ARRAY", () => {
    const e = parseRawEvent({
      type: "person_section",
      title: "One person",
      short_ids: ["pne16"],
    });
    expect(e).not.toBeNull();
  });

  it("rejects a scalar short_ids string — R wraps single ids with I() so this shape never ships", () => {
    // jsonlite auto_unbox=TRUE used to collapse a 1-element vector to a scalar string,
    // silently dropping single-person sections (and single-handle paper sections/bibtex).
    // Fixed in emit.R by wrapping with I(); the wire contract stays array-only.
    const e = parseRawEvent({
      type: "person_section",
      title: "One person",
      short_ids: "pne16",
      note: null,
    });
    expect(e).toBeNull();
  });

  it("rejects a person_section missing its title", () => {
    expect(parseRawEvent({ type: "person_section", short_ids: ["a"] })).toBeNull();
  });
});

describe("section mode field", () => {
  const base = { type: "section", title: "S", handles: ["h1", "h2"] };

  it.each(["keyword", "semantic", "journal_scan", "author", "wp", "editor", "person", "custom"])(
    "passes through known mode %s",
    (mode) => {
      const e = parseRawEvent({ ...base, mode });
      expect(e).not.toBeNull();
      if (e?.type === "section") expect(e.mode).toBe(mode);
    },
  );

  it("coerces an unknown mode string to undefined rather than rejecting", () => {
    const e = parseRawEvent({ ...base, mode: "vibes" });
    expect(e).not.toBeNull();
    if (e?.type === "section") expect(e.mode).toBeUndefined();
  });

  it("tolerates mode: null (older scripts / explicit NULL)", () => {
    const e = parseRawEvent({ ...base, mode: null });
    expect(e).not.toBeNull();
    if (e?.type === "section") expect(e.mode).toBeUndefined();
  });

  it("tolerates an absent mode (pre-mode scripts)", () => {
    const e = parseRawEvent(base);
    expect(e).not.toBeNull();
    if (e?.type === "section") expect(e.mode).toBeUndefined();
  });
});

describe("progress current/total null fix", () => {
  it("accepts the R shape with explicit nulls and coerces to undefined", () => {
    const e = parseRawEvent({
      type: "progress",
      label: "person_search: minimum wages…",
      current: null,
      total: null,
    });
    expect(e).not.toBeNull();
    if (e?.type === "progress") {
      expect(e.current).toBeUndefined();
      expect(e.total).toBeUndefined();
    }
  });

  it("keeps numeric current/total when present", () => {
    const e = parseRawEvent({ type: "progress", label: "x", current: 2, total: 5 });
    expect(e).not.toBeNull();
    if (e?.type === "progress") {
      expect(e.current).toBe(2);
      expect(e.total).toBe(5);
    }
  });
});

describe("captured end-to-end stream replay", () => {
  it.skipIf(!existsSync(CAPTURE))(
    "every line of the real sandbox run parses to a non-null event",
    () => {
      const lines = readFileSync(CAPTURE, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      const parsed = lines.map((l) => parseRawEvent(JSON.parse(l)));
      const dropped = parsed
        .map((e, i) => (e === null ? i : -1))
        .filter((i) => i >= 0)
        .map((i) => lines[i].slice(0, 80));
      expect(dropped).toEqual([]);
      expect(parsed.filter((e) => e?.type === "person").length).toBeGreaterThan(0);
      expect(parsed.filter((e) => e?.type === "person_section").length).toBeGreaterThan(0);
    },
  );
});
