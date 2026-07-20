import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Paper, Section } from "../../src/agent/types.js";

// Unit-test the assess() advisor's mapping from the assessor schema
// ({assessment, mode, reason, directive}) to the AssessResult (or null on failure/no-directive).
// generateStructured is mocked so there is no live LLM. computeFlags/summarizeResult are
// exercised separately in assess.test.ts; here we pin the normalisation logic.

const generateStructured = vi.fn();
vi.mock("../../src/llm/structured.js", () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
}));
vi.mock("../../src/agent/models.js", () => ({
  models: { assessor: {} },
  modelIds: { assessor: "stub/assessor" },
}));

async function importAssess() {
  const mod = await import("../../src/agent/stages/assess.js");
  return mod.assess;
}

const papers: Record<string, Paper> = {
  a: { handle: "a", title: "T", authors: ["A"], year: 2020, journal: "J", category: "C", url: "", abstract: null, bibtex: "" },
};
const sections: Section[] = [
  { id: "s1", title: "S", mode: "custom", n_total: 1, n_shown: 1, rows: [{ handle: "a", rank: 1 }] },
];
const base = { brief: "a clear economics brief about labour markets", script: "x", papers, sections };

describe("assess advisor mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a full advice object through unchanged", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "empty", reason: "Broadening.", directive: "Drop the filter.", mode: "replace" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const assess = await importAssess();
    expect(await assess(base)).toEqual({
      reason: "Broadening.",
      directive: "Drop the filter.",
      mode: "replace",
    });
  });

  it("defaults mode to 'augment' when omitted", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "thin", reason: "More.", directive: "Expand." },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const assess = await importAssess();
    const r = await assess(base);
    expect(r?.mode).toBe("augment");
  });

  it("falls back to a default reason when omitted", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "thin", directive: "Expand.", mode: "augment" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const assess = await importAssess();
    const r = await assess(base);
    expect((r?.reason.length ?? 0)).toBeGreaterThan(0);
  });

  it("returns null when the advisor produces no directive (nothing actionable)", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "meh", reason: "could be better" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const assess = await importAssess();
    expect(await assess(base)).toBeNull();
  });

  it("returns null on an LLM failure so the caller ships round 1", async () => {
    generateStructured.mockRejectedValue(new Error("502 from provider"));
    const assess = await importAssess();
    expect(await assess(base)).toBeNull();
  });

  it("passes the deterministic flags into the user prompt", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "empty", reason: "Broadening.", directive: "Widen.", mode: "replace" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const assess = await importAssess();
    await assess({ ...base, papers: {}, sections: [] }); // all_empty path
    const call = generateStructured.mock.calls[0][0] as { messages: { content: string }[] };
    const userMsg = call.messages[call.messages.length - 1].content;
    expect(userMsg).toMatch(/all_empty=true/);
  });
});
