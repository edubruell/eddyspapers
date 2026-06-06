import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit-test the clarify stage's mapping from the flat `action` schema
// ({assessment, action, question?, options?, reason?}) to the discriminated
// ClarifyResult union. generateStructured is mocked so there is no live LLM.

const generateStructured = vi.fn();
vi.mock("../../src/llm/structured.js", () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
}));
// models.ts pulls the OpenRouter client at import; stub it out so no key is needed.
vi.mock("../../src/agent/models.js", () => ({
  models: { clarifier: {} },
  modelIds: { clarifier: "stub/clarifier" },
}));

async function importClarify() {
  const mod = await import("../../src/agent/stages/clarify.js");
  return mod.clarify;
}

describe("clarify action mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps action 'proceed' to { action: 'proceed' }", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "clear", action: "proceed" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("a well-formed economics brief about minimum wages");
    expect(result).toEqual({ action: "proceed" });
  });

  it("maps action 'reject' to a reject result carrying the reason", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "off topic", action: "reject", reason: "Not economics." },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("how do I bake bread");
    expect(result).toEqual({ action: "reject", reason: "Not economics." });
  });

  it("supplies a default reason when reject omits one", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "off topic", action: "reject" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("how do I bake bread");
    expect(result.action).toBe("reject");
    if (result.action === "reject") expect(result.reason.length).toBeGreaterThan(0);
  });

  it("maps action 'ask' with question + options to a question result", async () => {
    generateStructured.mockResolvedValue({
      object: {
        assessment: "framing open",
        action: "ask",
        question: "USP relative to what?",
        options: ["Method", "Data", "New question"],
      },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("recent top-5 labour papers and their USP");
    expect(result).toEqual({
      action: "question",
      question: "USP relative to what?",
      options: ["Method", "Data", "New question"],
    });
  });

  it("defaults options to [] when 'ask' omits them", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "framing open", action: "ask", question: "Which country scope?" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("labour market frictions");
    expect(result.action).toBe("question");
    if (result.action === "question") {
      expect(result.options).toEqual([]);
      expect(result.question).toBe("Which country scope?");
    }
  });

  it("treats 'ask' WITHOUT a question as proceed (defensive fall-through)", async () => {
    generateStructured.mockResolvedValue({
      object: { assessment: "framing open", action: "ask" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    const clarify = await importClarify();
    const result = await clarify("labour market frictions");
    expect(result).toEqual({ action: "proceed" });
  });

  it("falls through to proceed when the LLM call throws (never strand on infra hiccup)", async () => {
    generateStructured.mockRejectedValue(new Error("openrouter 503"));
    const clarify = await importClarify();
    const result = await clarify("employment effects of minimum wages in Germany");
    expect(result).toEqual({ action: "proceed" });
  });
});
