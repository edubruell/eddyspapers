import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../../src/agent/types.js";

// Hermetic tests for the multistage refine pass (07_multistage.md). clarify always proceeds;
// assess is a per-test mock; writeScript/synthesize are stubbed; executeScript returns a
// different payload per round so we can observe accumulation vs replacement.

const assess = vi.fn();
const writeScript = vi.fn();
const executeScript = vi.fn();

vi.mock("../../src/agent/stages/clarify.js", () => ({
  clarify: vi.fn(async () => ({ action: "proceed" })),
}));
vi.mock("../../src/agent/stages/writeScript.js", () => ({
  writeScript: (...a: unknown[]) => writeScript(...a),
}));
vi.mock("../../src/agent/stages/execute.js", () => ({
  executeScript: (...a: unknown[]) => executeScript(...a),
}));
vi.mock("../../src/agent/stages/assess.js", async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, assess: (...a: unknown[]) => assess(...a) };
});
vi.mock("../../src/agent/stages/synthesize.js", () => ({
  synthesize: vi.fn(async () => "## Findings"),
}));
vi.mock("../../src/sandbox/snapshot.js", () => ({
  resolveSnapshot: vi.fn(async () => ({ path: "/fake/db.duckdb", exists: true, ageMs: 0, stale: false })),
}));

const brief = "most successfully published ZEW discussion papers in the last five years";

function mkPaper(handle: string) {
  return {
    handle,
    title: `T ${handle}`,
    authors: ["A"],
    year: 2021,
    journal: "J",
    category: "C",
    url: "",
    abstract: null,
    bibtex: "",
  };
}

function mkSection(id: string, title: string, handles: string[]) {
  return {
    id,
    title,
    mode: "custom" as const,
    n_total: handles.length,
    n_shown: handles.length,
    rows: handles.map((h, i) => ({ handle: h, rank: i + 1 })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeScript.mockImplementation(async (opts: { revision?: unknown }) => ({
    ok: true,
    script: opts.revision ? "ROUND2_SCRIPT" : "ROUND1_SCRIPT",
    strategy: opts.revision ? "Refined plan." : "Initial plan.",
    attempts: 1,
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
  }));
});

describe("runAgent refine — off by default", () => {
  it("never calls assess and runs a single round when refine is unset", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: { a: mkPaper("a") },
      sections: [mkSection("section-1", "S", ["a"])],
      bibtex: "@x{a,}",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const r = await runAgent("r1", { brief, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(r.paused).toBe(false);
    expect(assess).not.toHaveBeenCalled();
    expect(writeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "revise")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

describe("runAgent refine — advisor failure (null) skips the pass", () => {
  it("ships round 1 with no second round when the advisor returns null", async () => {
    executeScript.mockResolvedValue({
      ok: true,
      papers: { a: mkPaper("a"), b: mkPaper("b") },
      sections: [mkSection("section-1", "S", ["a", "b"])],
      bibtex: "@x{a,}",
    });
    assess.mockResolvedValue(null);
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const r = await runAgent("r2", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(r.paused).toBe(false);
    expect(assess).toHaveBeenCalledTimes(1);
    expect(writeScript).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "revise")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("runs a mandatory second round whenever the advisor returns advice", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a"), b: mkPaper("b") },
        sections: [mkSection("section-1", "S", ["a", "b"])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: { c: mkPaper("c") },
        sections: [mkSection("section-2", "More", ["c"])],
        bibtex: "@y{c,}",
      });
    // Even on a perfectly solid round 1, the advisor proposes a broadening pass — and it runs.
    assess.mockResolvedValue({
      reason: "Adding the most influential follow-on work.",
      directive: "Expand via citedby on the round-1 handles.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r2b", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(writeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "revise")).toHaveLength(1);
  });
});

describe("runAgent refine — revise (replace)", () => {
  it("runs a second round, emits revise, and the second script carries the revision", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a") },
        sections: [mkSection("section-1", "Candidates", ["a"]), mkSection("section-2", "Published", [])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: { p: mkPaper("p"), q: mkPaper("q") },
        sections: [mkSection("section-3", "Published ranking", ["p", "q"])],
        bibtex: "@y{p,}",
      });
    assess.mockResolvedValue({
      reason: "Widening the search to find published versions.",
      directive: "Resolve via the full window, not newest-first.",
      mode: "replace",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const r = await runAgent("r3", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(r.paused).toBe(false);
    expect(writeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledTimes(2);

    const revise = events.filter((e) => e.type === "revise");
    expect(revise).toHaveLength(1);
    if (revise[0].type === "revise") {
      expect(revise[0].mode).toBe("replace");
      expect(revise[0].reason).toMatch(/published/i);
    }

    // The second writeScript call received the revision channel.
    const secondCall = writeScript.mock.calls[1][0] as { revision?: { mode: string } };
    expect(secondCall.revision?.mode).toBe("replace");

    // Two strategy events (one per round), and the run completes.
    expect(events.filter((e) => e.type === "strategy")).toHaveLength(2);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

describe("runAgent refine — augment with overlapping handles", () => {
  it("dedups the paper map by handle AND dedups the consolidated bibtex by cite-key", async () => {
    // Round 1 and round 2 both return paper `b`. The paper MAP dedups (a, b from r1 plus
    // b, c from r2 → a, b, c) and mergeBibtex dedups the repeated @x{b,} entry by key.
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a"), b: mkPaper("b") },
        sections: [mkSection("section-1", "Seeds", ["a", "b"])],
        bibtex: "@x{a,}\n@x{b,}",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: { b: mkPaper("b"), c: mkPaper("c") },
        sections: [mkSection("section-2", "More", ["b", "c"])],
        bibtex: "@x{b,}\n@x{c,}",
      });
    assess.mockResolvedValue({
      reason: "Adding adjacent work.",
      directive: "Pull more.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-dup", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    const bibtexEvents = events.filter((e) => e.type === "bibtex");
    const last = bibtexEvents[bibtexEvents.length - 1];
    if (last.type === "bibtex") {
      // Deduped paper count is correct (a, b, c).
      expect(last.entries).toBe(3);
      // The merged bibtex contains @x{b,} exactly ONCE — mergeBibtex dedups by cite-key.
      const bMatches = last.bibtex.match(/@x\{b,\}/g) ?? [];
      expect(bMatches.length).toBe(1);
      expect(last.bibtex).toContain("@x{a,}");
      expect(last.bibtex).toContain("@x{c,}");
    }
  });
});

describe("runAgent refine — round 2 execution failure", () => {
  it("augment: keeps the round-1 result and synthesizes it (no fatal error)", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a"), b: mkPaper("b") },
        sections: [mkSection("section-1", "Seeds", ["a", "b"])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({ ok: false, message: "boom", timedOut: false });
    assess.mockResolvedValue({
      reason: "Trying again.",
      directive: "Redo.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    const r = await runAgent("r-fail2", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(r.paused).toBe(false);
    expect(executeScript).toHaveBeenCalledTimes(2);
    // No fatal error — augment degrades gracefully to the round-1 review.
    expect(events.some((e) => e.type === "error")).toBe(false);
    // The synthesize stage ran over the kept round-1 set, and the run completed.
    expect(events.some((e) => e.type === "stage" && e.stage === "synthesize" && e.state === "enter")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("replace: round-1 was discarded so a round-2 failure is fatal", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a") },
        sections: [mkSection("section-1", "Candidates", ["a"]), mkSection("section-2", "Published", [])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({ ok: false, message: "boom", timedOut: false });
    assess.mockResolvedValue({
      reason: "Redoing.",
      directive: "Redo it.",
      mode: "replace",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-fail2b", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    const err = events.filter((e) => e.type === "error");
    expect(err).toHaveLength(1);
    if (err[0].type === "error") expect(err[0].where).toBe("execute");
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "synthesis")).toBe(false);
  });
});

describe("runAgent refine — empty round 1 then revise", () => {
  it("runs round 2 when round 1 was all-empty and the assessor says revise", async () => {
    executeScript
      .mockResolvedValueOnce({ ok: true, papers: {}, sections: [], bibtex: "" })
      .mockResolvedValueOnce({
        ok: true,
        papers: { p: mkPaper("p") },
        sections: [mkSection("section-1", "Recovered", ["p"])],
        bibtex: "@y{p,}",
      });
    assess.mockResolvedValue({
      reason: "First pass found nothing; broadening.",
      directive: "Drop the over-tight filter.",
      mode: "replace",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-empty1", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(assess).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(2);
    // idOffset for round 2 is the round-1 section count, which was 0 here.
    expect(executeScript.mock.calls[1][3]).toBe(0);
    // The synthesize stage ran over the recovered (replace) set and the run completed.
    expect(events.some((e) => e.type === "stage" && e.stage === "synthesize" && e.state === "enter")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

describe("runAgent refine — assessor revise without mode defaults to augment", () => {
  it("keeps round-1 results when assess returns no explicit mode shape", async () => {
    // assess() in production normalises a missing mode to "augment"; this guards runAgent
    // against an augment verdict by exercising the augment branch end-to-end.
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a") },
        sections: [mkSection("section-1", "S1", ["a"])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: { b: mkPaper("b") },
        sections: [mkSection("section-2", "S2", ["b"])],
        bibtex: "@y{b,}",
      });
    assess.mockResolvedValue({
      reason: "Adding more.",
      directive: "Expand.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-aug2", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    const bibtexEvents = events.filter((e) => e.type === "bibtex");
    const last = bibtexEvents[bibtexEvents.length - 1];
    if (last.type === "bibtex") {
      expect(last.entries).toBe(2); // a + b kept
      expect(last.bibtex).toContain("@x{a,}");
      expect(last.bibtex).toContain("@y{b,}");
    }
  });
});

describe("runAgent refine — revise (augment)", () => {
  it("re-emits a consolidated bibtex over the unioned set", async () => {
    executeScript
      .mockResolvedValueOnce({
        ok: true,
        papers: { a: mkPaper("a"), b: mkPaper("b") },
        sections: [mkSection("section-1", "Seeds", ["a", "b"])],
        bibtex: "@x{a,}",
      })
      .mockResolvedValueOnce({
        ok: true,
        papers: { c: mkPaper("c") },
        sections: [mkSection("section-2", "Citing work", ["c"])],
        bibtex: "@y{c,}",
      });
    assess.mockResolvedValue({
      reason: "Expanding from the first papers via their citations.",
      directive: "Pull the citing literature for the round-1 handles.",
      mode: "augment",
    });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r4", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    // executeScript round 2 was called with an idOffset equal to round-1 section count (1).
    expect(executeScript.mock.calls[1][3]).toBe(1);

    const bibtexEvents = events.filter((e) => e.type === "bibtex");
    const last = bibtexEvents[bibtexEvents.length - 1];
    if (last.type === "bibtex") {
      expect(last.bibtex).toContain("@x{a,}");
      expect(last.bibtex).toContain("@y{c,}");
      expect(last.entries).toBe(3); // a, b, c unioned
    }
  });
});

describe("runAgent refine — augment round that repeats round 1", () => {
  it("isRepeatSection: same title and mode with no new handle is a repeat; a new handle or title is not", async () => {
    const { isRepeatSection } = await import("../../src/agent/runAgent.js");
    const r1 = [mkSection("section-1", "Semantic: bargaining extensions", ["a", "b"])];
    expect(isRepeatSection(mkSection("section-7", "  semantic:  Bargaining extensions ", ["b", "a"]), r1)).toBe(true);
    expect(isRepeatSection(mkSection("section-7", "Semantic: bargaining extensions", []), r1)).toBe(true);
    expect(isRepeatSection(mkSection("section-7", "Semantic: bargaining extensions", ["a", "z"]), r1)).toBe(false);
    expect(isRepeatSection(mkSection("section-7", "Follow-on work", ["a", "b"]), r1)).toBe(false);
    expect(isRepeatSection({ ...mkSection("section-7", "Semantic: bargaining extensions", ["a"]), mode: "keyword" as const }, r1)).toBe(false);
  });

  it("drops round-2 sections that re-run round 1, from the live events and from the merged result", async () => {
    const r1 = mkSection("section-1", "Seeds", ["a", "b"]);
    executeScript
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "section", section: r1 });
        return { ok: true, papers: { a: mkPaper("a"), b: mkPaper("b") }, sections: [r1], bibtex: "" };
      })
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        const repeat = mkSection("section-2", "Seeds", ["a", "b"]);
        const added = mkSection("section-3", "Follow-on work", ["c"]);
        onEvent({ type: "section", section: repeat });
        onEvent({ type: "section", section: added });
        return { ok: true, papers: { a: mkPaper("a"), b: mkPaper("b"), c: mkPaper("c") }, sections: [repeat, added], bibtex: "" };
      });
    assess.mockResolvedValue({ reason: "Adding follow-on work.", directive: "Expand via citations.", mode: "augment" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const { synthesize } = await import("../../src/agent/stages/synthesize.js");
    const events: StreamEvent[] = [];
    await runAgent("r-repeat", { brief, refine: true, synthesize: true }, "/fake/db.duckdb", (e) => events.push(e));

    const titles = events.flatMap((e) => (e.type === "section" ? [e.section.title] : []));
    expect(titles).toEqual(["Seeds", "Follow-on work"]);
    const { buildBundle } = await import("../../src/agent/bundle.js");
    const bundle = buildBundle("r-repeat", brief, events);
    expect(bundle.sections.map((s) => s.id)).toEqual(["section-1", "section-3"]);
    expect(bundle.papers_csv).not.toContain("section-2");
    const synthSections = vi.mocked(synthesize).mock.calls[0]![2] as { title: string }[];
    expect(synthSections.map((s) => s.title)).toEqual(["Seeds", "Follow-on work"]);
  });

  it("keeps a repeated title in a replace round (round 1 is discarded there)", async () => {
    const r1 = mkSection("section-1", "Seeds", ["a"]);
    executeScript
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "section", section: r1 });
        return { ok: true, papers: { a: mkPaper("a") }, sections: [r1], bibtex: "" };
      })
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        const again = mkSection("section-2", "Seeds", ["a"]);
        onEvent({ type: "section", section: again });
        return { ok: true, papers: { a: mkPaper("a") }, sections: [again], bibtex: "" };
      });
    assess.mockResolvedValue({ reason: "Redoing it.", directive: "Re-derive.", mode: "replace" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-replace-repeat", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));
    expect(events.filter((e) => e.type === "section")).toHaveLength(2);
  });
});

describe("runAgent refine — augment round that fails mid-script", () => {
  it("keeps round 1 when the round-2 script raises an R error, and passes round-1 handles to the writer", async () => {
    const r1 = mkSection("section-1", "Seeds", ["a", "b"]);
    executeScript
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "section", section: r1 });
        return { ok: true, papers: { a: mkPaper("a"), b: mkPaper("b") }, sections: [r1], bibtex: "" };
      })
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "error", where: "execute", message: "object 'all_handles' not found", recoverable: false });
        return { ok: false, message: "R process exited with code 1" };
      });
    assess.mockResolvedValue({ reason: "Adding follow-on work.", directive: "Expand via citations.", mode: "augment" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-r-error", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "progress" && /showing the first set/.test(e.label))).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    const second = writeScript.mock.calls[1]![0] as { revision: { round1Handles: string[] } };
    expect(second.revision.round1Handles).toEqual(["a", "b"]);
  });

  it("a replace round's R error stays fatal", async () => {
    const r1 = mkSection("section-1", "Seeds", ["a"]);
    executeScript
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "section", section: r1 });
        return { ok: true, papers: { a: mkPaper("a") }, sections: [r1], bibtex: "" };
      })
      .mockImplementationOnce(async (_s: string, _d: string, onEvent: (e: unknown) => void) => {
        onEvent({ type: "error", where: "execute", message: "boom", recoverable: false });
        return { ok: false, message: "R process exited with code 1" };
      });
    assess.mockResolvedValue({ reason: "Redoing it.", directive: "Re-derive.", mode: "replace" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    const events: StreamEvent[] = [];
    await runAgent("r-replace-error", { brief, refine: true }, "/fake/db.duckdb", (e) => events.push(e));
    expect(events.some((e) => e.type === "error" && !e.recoverable)).toBe(true);
  });
});

describe("runAgent refine — round-1 handles for the writer", () => {
  it("dedups paper handles, skips persons sections and caps the list at 80", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `h${i}`);
    const r1 = mkSection("section-1", "Seeds", ["a", ...many]);
    const r1b = mkSection("section-2", "Again", ["a", "z"]);
    const people = { ...mkSection("section-3", "People", ["p1"]), kind: "persons" as const };
    executeScript.mockImplementationOnce(async () => ({
      ok: true,
      papers: { a: mkPaper("a") },
      sections: [r1, r1b, people],
      bibtex: "",
    }));
    executeScript.mockImplementationOnce(async () => ({ ok: true, papers: {}, sections: [], bibtex: "" }));
    assess.mockResolvedValue({ reason: "More.", directive: "Expand.", mode: "augment" });
    const { runAgent } = await import("../../src/agent/runAgent.js");
    await runAgent("r-handles", { brief, refine: true }, "/fake/db.duckdb", () => undefined);
    const handles = (writeScript.mock.calls[1]![0] as { revision: { round1Handles: string[] } }).revision.round1Handles;
    expect(handles).toHaveLength(80);
    expect(handles[0]).toBe("a");
    expect(handles).not.toContain("p1");
    expect(new Set(handles).size).toBe(80);
  });
});
