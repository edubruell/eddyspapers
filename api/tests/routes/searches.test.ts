import { describe, it, expect } from "vitest";
import { toShareDto } from "../../src/routes/searches.js";
import type { StoredSearch } from "../../src/db/searches.js";

// Only the pure share-DTO projection is unit-tested here. The route handler itself reads the
// singleton DuckDB (an effectful boundary) and is exercised end-to-end, not inline (00 §6).

const stored: StoredSearch = {
  id: "RePEc:hash:abc",
  brief: "minimum wages and employment",
  categories: ["Top 5"],
  minYear: 2015,
  dbSnapshotDate: "2026-06-05",
  createdAt: "2026-06-07T10:00:00Z",
  status: "done",
  events: [
    { type: "strategy", seq: 1, strategy: "sweep top journals" },
    { type: "synthesis", seq: 2, delta: "Result." },
    { type: "done", seq: 3, ms_total: 1234 },
  ] as StoredSearch["events"],
  synthesis: "Result.",
  clarifyQuestion: "secret question",
  clarifyAnswer: "secret answer",
  refine: false,
};

describe("toShareDto", () => {
  it("projects only the public share fields", () => {
    const dto = toShareDto(stored);
    expect(dto).toEqual({
      id: "RePEc:hash:abc",
      brief: "minimum wages and employment",
      status: "done",
      createdAt: "2026-06-07T10:00:00Z",
      minYear: 2015,
      categories: ["Top 5"],
      events: stored.events,
    });
  });

  it("drops internal/sensitive columns (clarify answer, snapshot date, synthesis blob)", () => {
    const dto = toShareDto(stored) as unknown as Record<string, unknown>;
    expect(dto.clarifyAnswer).toBeUndefined();
    expect(dto.clarifyQuestion).toBeUndefined();
    expect(dto.dbSnapshotDate).toBeUndefined();
    expect(dto.synthesis).toBeUndefined();
    expect(dto.refine).toBeUndefined();
  });

  it("carries the events array verbatim as the replay payload", () => {
    expect(toShareDto(stored).events).toHaveLength(3);
    expect(toShareDto(stored).events[2]).toMatchObject({ type: "done" });
  });
});
