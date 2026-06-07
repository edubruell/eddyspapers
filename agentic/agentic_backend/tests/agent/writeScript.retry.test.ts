import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the LLM call and the AST/SQL checker so we can drive the writeScript retry loop
// deterministically. These assert the fix for the "abort on attempt 1" bug: a hard LLM
// error (e.g. structured-output schema mismatch from the cheap writer model) must NOT end
// the run — it escalates to the retry model and tries again.
const generateStructured = vi.fn();
const checkScript = vi.fn();

vi.mock("../../src/llm/structured.js", () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
}));
vi.mock("../../src/sandbox/checkScript.js", () => ({
  checkScript: (...args: unknown[]) => checkScript(...args),
}));

const USAGE = { promptTokens: 1, completionTokens: 1, cachedTokens: 0 };
const BRIEF = "Find papers on the employment effects of minimum wages in Germany";

async function load() {
  vi.resetModules();
  vi.stubEnv("MODEL_WRITER", "cheap-writer");
  vi.stubEnv("MODEL_WRITER_RETRY", "sturdy-retry");
  const mod = await import("../../src/agent/stages/writeScript.js");
  return mod.writeScript;
}

function modelIdOfCall(i: number): string {
  return (generateStructured.mock.calls[i][0] as { modelId: string }).modelId;
}

describe("writeScript retry loop on LLM error", () => {
  beforeEach(() => {
    generateStructured.mockReset();
    checkScript.mockReset();
    checkScript.mockResolvedValue({ ok: true });
  });

  it("escalates to the retry model and recovers when the writer model throws once", async () => {
    const writeScript = await load();
    generateStructured
      .mockRejectedValueOnce(new Error("No object generated: response did not match schema"))
      .mockResolvedValueOnce({ object: { strategy: "plan", script: "x <- 1" }, usage: USAGE });

    const result = await writeScript({ brief: BRIEF, dbDate: "2026-06-05" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.script).toBe("x <- 1");
      expect(result.attempts).toBe(2);
    }
    // attempt 1 used the cheap writer; after the throw it escalated to the retry model.
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(modelIdOfCall(0)).toBe("cheap-writer");
    expect(modelIdOfCall(1)).toBe("sturdy-retry");
  });

  it("surfaces the LLM error only after all three attempts are exhausted", async () => {
    const writeScript = await load();
    generateStructured.mockRejectedValue(new Error("No object generated: response did not match schema"));

    const result = await writeScript({ brief: BRIEF, dbDate: "2026-06-05" });

    expect(result.ok).toBe(false);
    if (!result.ok && "attempts" in result) {
      expect(result.attempts).toBe(3);
      expect(result.reason).toMatch(/LLM error/);
    }
    expect(generateStructured).toHaveBeenCalledTimes(3);
  });

  it("still recovers via the retry model when the writer keeps producing invalid scripts", async () => {
    const writeScript = await load();
    generateStructured.mockResolvedValue({ object: { strategy: "plan", script: "bad" }, usage: USAGE });
    // First two scripts fail validation; the third (retry model) passes.
    checkScript
      .mockResolvedValueOnce({ ok: false, reason: "disallowed call", offendingNode: "system", hint: "use the verbs" })
      .mockResolvedValueOnce({ ok: false, reason: "disallowed call", offendingNode: "system", hint: "use the verbs" })
      .mockResolvedValueOnce({ ok: true });

    const result = await writeScript({ brief: BRIEF, dbDate: "2026-06-05" });

    expect(result.ok).toBe(true);
    // validation-rejection path keeps the cheap model for attempts 1-2, then the retry model.
    expect(modelIdOfCall(0)).toBe("cheap-writer");
    expect(modelIdOfCall(1)).toBe("cheap-writer");
    expect(modelIdOfCall(2)).toBe("sturdy-retry");
  });
});
