import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeSearchId } from "../../src/agent/cache.js";
import { EventBus } from "../../src/stream/bus.js";
import type { StreamEvent, StreamEventPayload } from "../../src/agent/types.js";

// ── computeSearchId ───────────────────────────────────────────────────────────

describe("computeSearchId", () => {
  const base = {
    brief: "employment effects of minimum wages",
    dbSnapshotDate: "2025-01-15",
  };

  it("returns a 16-char hex string", () => {
    const id = computeSearchId(base);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same input produces same id", () => {
    expect(computeSearchId(base)).toBe(computeSearchId(base));
  });

  it("is HMAC-keyed, not a plain hash of the payload (S6 — id must not be brief-derivable)", async () => {
    // The run id doubles as an ungated share/stream token; a plain SHA-256 of the payload
    // would let anyone reconstruct it from the brief. Guard against a revert to plain hash.
    const { createHash } = await import("crypto");
    const payload = JSON.stringify({
      brief: base.brief,
      categories: [],
      minYear: null,
      mustInclude: [],
      refine: false,
      dbSnapshotDate: base.dbSnapshotDate,
    });
    const plain = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    expect(computeSearchId(base)).not.toBe(plain);
  });

  it("different briefs produce different ids", () => {
    const id1 = computeSearchId({ ...base, brief: "minimum wages employment" });
    const id2 = computeSearchId({ ...base, brief: "monetary policy inflation" });
    expect(id1).not.toBe(id2);
  });

  it("different dbSnapshotDates produce different ids", () => {
    const id1 = computeSearchId({ ...base, dbSnapshotDate: "2025-01-01" });
    const id2 = computeSearchId({ ...base, dbSnapshotDate: "2025-06-01" });
    expect(id1).not.toBe(id2);
  });

  it("different minYear values produce different ids", () => {
    const id1 = computeSearchId({ ...base, minYear: 2010 });
    const id2 = computeSearchId({ ...base, minYear: 2020 });
    expect(id1).not.toBe(id2);
  });

  it("undefined minYear and null minYear are treated equivalently", () => {
    // Both cases serialize minYear as null
    const idUndefined = computeSearchId({ ...base });
    const idWithNull = computeSearchId({ ...base, minYear: undefined });
    expect(idUndefined).toBe(idWithNull);
  });

  it("categories are sorted before hashing — order should not matter", () => {
    const id1 = computeSearchId({ ...base, categories: ["macro", "labor", "finance"] });
    const id2 = computeSearchId({ ...base, categories: ["finance", "macro", "labor"] });
    expect(id1).toBe(id2);
  });

  it("sorted categories produce a different id from different category sets", () => {
    const id1 = computeSearchId({ ...base, categories: ["macro", "labor"] });
    const id2 = computeSearchId({ ...base, categories: ["macro", "trade"] });
    expect(id1).not.toBe(id2);
  });

  it("undefined categories and empty categories produce the same id", () => {
    const idUndefined = computeSearchId({ ...base });
    const idEmpty = computeSearchId({ ...base, categories: [] });
    expect(idUndefined).toBe(idEmpty);
  });

  it("single category produces a stable id", () => {
    const id = computeSearchId({ ...base, categories: ["labor"] });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("includes mustInclude in the hash (Phase 4 widened the key)", () => {
    // Different must-include sets steer the search differently, so they must not
    // collide onto one cached result (PLAN.md §D1).
    const id1 = computeSearchId({ ...base, mustInclude: ["repec:iza:izadps:dp123"] });
    const id2 = computeSearchId({ ...base });
    expect(id1).not.toBe(id2);
  });

  it("is order-insensitive for mustInclude", () => {
    const id1 = computeSearchId({ ...base, mustInclude: ["b", "a"] });
    const id2 = computeSearchId({ ...base, mustInclude: ["a", "b"] });
    expect(id1).toBe(id2);
  });

  it("includes refine in the hash", () => {
    const id1 = computeSearchId({ ...base, refine: true });
    const id2 = computeSearchId({ ...base, refine: false });
    expect(id1).not.toBe(id2);
  });
});

// ── EventBus ──────────────────────────────────────────────────────────────────

const makeStageEvent = (seq: number, stage: "clarify" | "write" | "validate" | "execute" | "synthesize" = "clarify"): StreamEvent => ({
  type: "stage",
  seq,
  stage,
  state: "enter",
});

const makeDoneEvent = (seq: number): StreamEvent => ({
  type: "done",
  seq,
  ms_total: 1234,
});

const makeErrorEvent = (seq: number, recoverable: boolean): StreamEvent => ({
  type: "error",
  seq,
  where: "execute",
  message: "boom",
  recoverable,
});

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("publish then subscribe replays the event", () => {
    bus.publish("s1", makeStageEvent(0));
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => received.push(e));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("stage");
  });

  it("subscriber receives live events published after subscribe", () => {
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => received.push(e));
    bus.publish("s1", makeStageEvent(0));
    bus.publish("s1", makeStageEvent(1, "write"));
    expect(received).toHaveLength(2);
  });

  it("fromSeq filters replay — events below fromSeq are not replayed", () => {
    bus.publish("s1", makeStageEvent(0));
    bus.publish("s1", makeStageEvent(1, "write"));
    bus.publish("s1", makeStageEvent(2, "execute"));
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 2, (e) => received.push(e));
    // Only seq=2 should be replayed
    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(2);
  });

  it("fromSeq=0 replays all buffered events", () => {
    bus.publish("s1", makeStageEvent(0));
    bus.publish("s1", makeStageEvent(1, "write"));
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => received.push(e));
    expect(received).toHaveLength(2);
  });

  it("isDone is false before a done event", () => {
    bus.publish("s1", makeStageEvent(0));
    expect(bus.isDone("s1")).toBe(false);
  });

  it("isDone is true after a done event is published", () => {
    bus.publish("s1", makeStageEvent(0));
    bus.publish("s1", makeDoneEvent(1));
    expect(bus.isDone("s1")).toBe(true);
  });

  it("isDone is true after an unrecoverable error event", () => {
    bus.publish("s1", makeErrorEvent(0, false));
    expect(bus.isDone("s1")).toBe(true);
  });

  it("isDone remains false after a recoverable error event", () => {
    bus.publish("s1", makeErrorEvent(0, true));
    expect(bus.isDone("s1")).toBe(false);
  });

  it("isDone returns false for an unknown searchId", () => {
    expect(bus.isDone("nonexistent")).toBe(false);
  });

  it("unsubscribe stops the listener from receiving future events", () => {
    const received: StreamEvent[] = [];
    const unsubscribe = bus.subscribe("s1", 0, (e) => received.push(e));
    bus.publish("s1", makeStageEvent(0));
    unsubscribe();
    bus.publish("s1", makeStageEvent(1, "write"));
    // Only the first event was received before unsubscribe
    expect(received).toHaveLength(1);
  });

  it("subscribe after done returns a no-op unsubscribe and replays", () => {
    bus.publish("s1", makeStageEvent(0));
    bus.publish("s1", makeDoneEvent(1));
    const received: StreamEvent[] = [];
    const unsubscribe = bus.subscribe("s1", 0, (e) => received.push(e));
    // Should have replayed both events
    expect(received).toHaveLength(2);
    // Unsubscribe should be a no-op (not throw)
    expect(() => unsubscribe()).not.toThrow();
  });

  it("multiple subscribers on the same searchId all receive events", () => {
    const received1: StreamEvent[] = [];
    const received2: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => received1.push(e));
    bus.subscribe("s1", 0, (e) => received2.push(e));
    bus.publish("s1", makeStageEvent(0));
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("listener errors do not kill the bus or other listeners", () => {
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 0, () => { throw new Error("bad listener"); });
    bus.subscribe("s1", 0, (e) => received.push(e));
    expect(() => bus.publish("s1", makeStageEvent(0))).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it("cleanup removes the entry so isDone returns false again", () => {
    bus.publish("s1", makeDoneEvent(0));
    expect(bus.isDone("s1")).toBe(true);
    bus.cleanup("s1");
    expect(bus.isDone("s1")).toBe(false);
  });

  it("cleanup removes buffered events — subscribe after cleanup gets nothing", () => {
    bus.publish("s1", makeStageEvent(0));
    bus.cleanup("s1");
    const received: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => received.push(e));
    expect(received).toHaveLength(0);
  });

  it("different searchIds are isolated", () => {
    const r1: StreamEvent[] = [];
    const r2: StreamEvent[] = [];
    bus.subscribe("s1", 0, (e) => r1.push(e));
    bus.subscribe("s2", 0, (e) => r2.push(e));
    bus.publish("s1", makeStageEvent(0));
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(0);
  });
});

// ── parseAuthors (tested indirectly via execute event translation) ─────────────
// parseAuthors is not exported, so we test the observable behaviour of executeScript
// by mocking runSandbox and observing what Paper objects are produced.

describe("parseAuthors (via executeScript)", () => {
  it("splits comma-separated authors correctly", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");

    // Mock runSandbox to emit one paper event with comma-separated authors
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");
    vi.mock("../../src/sandbox/runSandbox.js", () => ({
      runSandbox: vi.fn(),
    }));
    const mockedRunSandbox = vi.mocked(runSandbox);

    mockedRunSandbox.mockImplementationOnce(async (_path, _db, cb) => {
      cb({
        type: "paper",
        handle: "repec:test:1",
        title: "Test Paper",
        year: 2020,
        authors: "Smith, John, Jones, Alice",
        journal: "Test Journal",
        category: "labor",
        url: "http://example.com",
        abstract: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const papers: Record<string, unknown>[] = [];
    const result = await executeScript("dummy script", "/fake/db.duckdb", (e) => {
      if (e.type === "paper") papers.push(e.paper as unknown as Record<string, unknown>);
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.papers["repec:test:1"].authors).toEqual(["Smith", "John", "Jones", "Alice"]);
    }

    vi.restoreAllMocks();
  });

  it("splits 'and'-separated authors correctly", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    const mockedRunSandbox = vi.mocked(runSandbox);

    mockedRunSandbox.mockImplementationOnce(async (_path, _db, cb) => {
      cb({
        type: "paper",
        handle: "repec:test:2",
        title: "Another Paper",
        year: 2021,
        authors: "Smith, John and Jones, Alice",
        journal: "Test Journal",
        category: "macro",
        url: "http://example.com",
        abstract: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      // "Smith" + "John" + "Jones" + "Alice" — splits on both "and" and ","
      expect(result.papers["repec:test:2"].authors).toContain("Smith");
      expect(result.papers["repec:test:2"].authors).toContain("Jones");
    }

    vi.restoreAllMocks();
  });

  it("handles a single author with no delimiter", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    const mockedRunSandbox = vi.mocked(runSandbox);

    mockedRunSandbox.mockImplementationOnce(async (_path, _db, cb) => {
      cb({
        type: "paper",
        handle: "repec:test:3",
        title: "Solo Paper",
        year: 2022,
        authors: "Müller, Klaus",
        journal: "Test Journal",
        category: "finance",
        url: "http://example.com",
        abstract: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.papers["repec:test:3"].authors).toContain("Müller");
      expect(result.papers["repec:test:3"].authors).toContain("Klaus");
    }

    vi.restoreAllMocks();
  });

  it("filters empty strings from author list", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    const mockedRunSandbox = vi.mocked(runSandbox);

    mockedRunSandbox.mockImplementationOnce(async (_path, _db, cb) => {
      cb({
        type: "paper",
        handle: "repec:test:4",
        title: "Trimmed Paper",
        year: 2023,
        authors: "Smith, John,  , Jones",
        journal: "Test Journal",
        category: "labor",
        url: "http://example.com",
        abstract: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      const authors = result.papers["repec:test:4"].authors;
      expect(authors.every((a) => a.length > 0)).toBe(true);
    }

    vi.restoreAllMocks();
  });
});

// ── StreamEvent discriminated union type shape ────────────────────────────────
// These are compile-time type tests expressed as runtime assertions to catch
// accidental structural regressions. We verify that the discriminant fields
// and required properties are present as expected.

describe("StreamEvent shape spot-checks", () => {
  it("stage event has type, seq, stage, state fields", () => {
    const e: StreamEvent = { type: "stage", seq: 0, stage: "clarify", state: "enter" };
    expect(e.type).toBe("stage");
    expect(e.seq).toBe(0);
    expect(e.stage).toBe("clarify");
    expect(e.state).toBe("enter");
  });

  it("stage event exit carries optional ms", () => {
    const e: StreamEvent = { type: "stage", seq: 1, stage: "execute", state: "exit", ms: 42 };
    expect(e.ms).toBe(42);
  });

  it("assistant event carries delta and stage", () => {
    const e: StreamEvent = { type: "assistant", seq: 2, stage: "clarify", delta: "hello" };
    expect(e.delta).toBe("hello");
    expect(e.stage).toBe("clarify");
  });

  it("script event carries delta only (no stage field)", () => {
    const e: StreamEvent = { type: "script", seq: 3, delta: "library(eddysearch)" };
    expect(e.delta).toContain("library");
    // script events do NOT have a stage field on the StreamEvent union
    expect("stage" in e).toBe(false);
  });

  it("validate event carries ok boolean", () => {
    const ok: StreamEvent = { type: "validate", seq: 4, ok: true };
    const fail: StreamEvent = { type: "validate", seq: 5, ok: false, reason: "bad node", offending: "system()" };
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.reason).toBe("bad node");
      expect(fail.offending).toBe("system()");
    }
  });

  it("error event carries where, message, recoverable", () => {
    const e: StreamEvent = { type: "error", seq: 6, where: "execute", message: "timeout", recoverable: false };
    expect(e.where).toBe("execute");
    expect(e.recoverable).toBe(false);
  });

  it("done event carries ms_total", () => {
    const e: StreamEvent = { type: "done", seq: 7, ms_total: 5000 };
    expect(e.ms_total).toBe(5000);
  });

  it("synthesis event carries delta (no stage field)", () => {
    const e: StreamEvent = { type: "synthesis", seq: 8, delta: "## Summary" };
    expect(e.delta).toBe("## Summary");
    expect("stage" in e).toBe(false);
  });

  it("bibtex event carries entries count and bibtex string", () => {
    const bib = "@article{smith2020, ...}";
    const e: StreamEvent = { type: "bibtex", seq: 9, entries: 1, bibtex: bib };
    expect(e.entries).toBe(1);
    expect(e.bibtex).toBe(bib);
  });

  it("progress event carries label, optional current and total", () => {
    const e: StreamEvent = { type: "progress", seq: 10, label: "searching...", current: 3, total: 10 };
    expect(e.label).toBe("searching...");
    expect(e.current).toBe(3);
    expect(e.total).toBe(10);
  });

  it("StreamEventPayload omits seq from each variant", () => {
    // Verify DistributiveOmit works: a payload should not carry seq
    const payload: StreamEventPayload = { type: "done", ms_total: 100 };
    expect("seq" in payload).toBe(false);
  });
});

// ── executeScript sandbox integration (no live R) ────────────────────────────

describe("executeScript result assembly", () => {
  it("returns ok:false with message when sandbox times out", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    vi.mocked(runSandbox).mockResolvedValueOnce({
      exitCode: -1,
      timedOut: true,
      stdout: "",
      stderr: "",
      events: [],
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.message).toMatch(/timed out/i);
    }

    vi.restoreAllMocks();
  });

  it("salvages partial papers/sections when the sandbox times out after streaming some", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    vi.mocked(runSandbox).mockImplementationOnce(async (_p, _d, cb) => {
      cb({
        type: "paper",
        handle: "repec:a:1",
        title: "Salvaged Paper",
        year: 2024,
        authors: "A. Author",
        journal: "Some Journal",
        category: "Working Paper Series",
        url: "https://example.com/1",
        similarity: 0.1,
        abstract: null,
      });
      cb({ type: "section", title: "Partial results", handles: ["repec:a:1"], note: null });
      return { exitCode: -1, timedOut: true, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partial).toBe(true);
      expect(Object.keys(result.papers)).toEqual(["repec:a:1"]);
      expect(result.sections).toHaveLength(1);
    }

    vi.restoreAllMocks();
  });

  it("returns ok:false with stderr excerpt when exit code is non-zero", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    vi.mocked(runSandbox).mockResolvedValueOnce({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "Error: object 'foo' not found",
      events: [],
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(false);
      expect(result.message).toContain("1");
    }

    vi.restoreAllMocks();
  });

  it("accumulates sections in order with correct rank assignment", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    vi.mocked(runSandbox).mockImplementationOnce(async (_p, _d, cb) => {
      cb({
        type: "section",
        title: "Top Papers",
        handles: ["repec:a:1", "repec:a:2", "repec:a:3"],
        note: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sections).toHaveLength(1);
      const rows = result.sections[0].rows;
      expect(rows[0].rank).toBe(1);
      expect(rows[1].rank).toBe(2);
      expect(rows[2].rank).toBe(3);
    }

    vi.restoreAllMocks();
  });

  it("section rows carry similarity from previously emitted paper events", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    vi.mocked(runSandbox).mockImplementationOnce(async (_p, _d, cb) => {
      cb({
        type: "paper",
        handle: "repec:b:1",
        title: "Sim Paper",
        year: 2019,
        authors: "Author One",
        journal: "J",
        category: "labor",
        url: "http://ex.com",
        abstract: null,
        similarity: 0.92,
      });
      cb({
        type: "section",
        title: "Semantic Results",
        handles: ["repec:b:1"],
        note: null,
      });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const result = await executeScript("dummy", "/fake/db.duckdb", () => {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sections[0].rows[0].similarity).toBeCloseTo(0.92);
    }

    vi.restoreAllMocks();
  });

  it("bibtex is captured and entry count is inferred from @ markers when entries field absent", async () => {
    const { executeScript } = await import("../../src/agent/stages/execute.js");
    const { runSandbox } = await import("../../src/sandbox/runSandbox.js");

    vi.mock("../../src/sandbox/runSandbox.js");
    const bib = "@article{a,}\n@article{b,}\n@article{c,}";
    vi.mocked(runSandbox).mockImplementationOnce(async (_p, _d, cb) => {
      cb({ type: "bibtex", bibtex: bib });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", events: [] };
    });

    const emitted: StreamEventPayload[] = [];
    const result = await executeScript("dummy", "/fake/db.duckdb", (e) => emitted.push(e));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bibtex).toBe(bib);
    }

    const bibtexEvent = emitted.find((e) => e.type === "bibtex");
    expect(bibtexEvent).toBeDefined();
    if (bibtexEvent?.type === "bibtex") {
      expect(bibtexEvent.entries).toBe(3);
    }

    vi.restoreAllMocks();
  });
});
