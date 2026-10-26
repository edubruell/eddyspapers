import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// generateStructured wraps the `ai` SDK generateObject. A provider stall once held a
// lit_search open for ten minutes, so the wrapper must bound every call with an abort
// signal and log a failed call before rethrowing it to the caller's fallback.

const captured: { args?: any } = {};
const nextOutcome: { value?: () => Promise<unknown> } = {};

vi.mock("ai", () => ({
  generateObject: vi.fn((args: any) => {
    captured.args = args;
    return nextOutcome.value!();
  }),
}));

const importStructured = async () => (await import("../../src/llm/structured.js")).generateStructured;

const call = async (timeoutMs?: number) =>
  (await importStructured())({
    model: {} as any,
    modelId: "test/model",
    messages: [],
    schema: {} as any,
    stage: "write:attempt1",
    timeoutMs,
  });

describe("generateStructured", () => {
  beforeEach(() => {
    captured.args = undefined;
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes an AbortSignal to generateObject and returns object and usage", async () => {
    nextOutcome.value = async () => ({
      object: { ok: true },
      usage: { promptTokens: 10, completionTokens: 5, promptTokensDetails: { cachedTokens: 3 } },
    });
    const out = await call();
    expect(captured.args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ object: { ok: true }, usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 3 } });
  });

  it("aborts a stalled call after timeoutMs", async () => {
    nextOutcome.value = () =>
      new Promise((_, reject) => {
        captured.args.abortSignal.addEventListener("abort", () => reject(captured.args.abortSignal.reason));
      });
    await expect(call(20)).rejects.toThrow();
    expect(captured.args.abortSignal.aborted).toBe(true);
  });

  it("logs the stage, model and error of a failed call, then rethrows", async () => {
    nextOutcome.value = async () => {
      throw new Error("No object generated");
    };
    await expect(call()).rejects.toThrow("No object generated");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/write:attempt1 FAILED \| test\/model \| \d+ms \| Error: No object generated/),
    );
  });
});
