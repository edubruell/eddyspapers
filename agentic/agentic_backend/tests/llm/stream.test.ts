import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// streamStructured wraps the `ai` SDK streamText. We mock streamText so no
// network/LLM is involved and assert the three behaviours the bug fix added:
//   1. happy path returns the provider finishReason and forwards deltas;
//   2. an error surfaced via the onError callback (the v4 SDK swallows error
//      chunks on textStream) is turned into a thrown Error so runAgent's catch
//      can emit error+done and stop the spinner;
//   3. maxTokens and an abortSignal are passed through to streamText.

const captured: { args?: any } = {};
const nextResult: { value?: any } = {};

const makeResult = (opts: {
  deltas: string[];
  finishReason?: string;
  errorViaCallback?: unknown;
}) => {
  let onErrorCb: ((e: { error: unknown }) => void) | undefined;
  return {
    setOnError(cb: (e: { error: unknown }) => void) {
      onErrorCb = cb;
    },
    get textStream() {
      return (async function* () {
        for (const d of opts.deltas) yield d;
        if (opts.errorViaCallback !== undefined) {
          onErrorCb?.({ error: opts.errorViaCallback });
        }
      })();
    },
    finishReason: Promise.resolve(opts.finishReason ?? "stop"),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
  };
};

vi.mock("ai", () => ({
  streamText: vi.fn((args: any) => {
    captured.args = args;
    const result = nextResult.value;
    result.setOnError(args.onError);
    return result;
  }),
}));

const importStream = async () => (await import("../../src/llm/stream.js")).streamStructured;

describe("streamStructured", () => {
  beforeEach(() => {
    captured.args = undefined;
    nextResult.value = undefined;
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it("forwards deltas and returns the provider finishReason on a clean finish", async () => {
    const streamStructured = await importStream();
    nextResult.value = makeResult({ deltas: ["a", "b", "c"], finishReason: "length" });
    const seen: string[] = [];

    const out = await streamStructured({
      model: {} as any,
      modelId: "test/model",
      messages: [],
      stage: "synthesize",
      onDelta: (d) => seen.push(d),
      maxTokens: 1234,
    });

    expect(seen).toEqual(["a", "b", "c"]);
    expect(out).toEqual({ finishReason: "length" });
  });

  it("throws when the stream reports an error via onError (textStream does not throw)", async () => {
    const streamStructured = await importStream();
    nextResult.value = makeResult({
      deltas: ["partial"],
      errorViaCallback: new Error("provider stalled / out of tokens"),
    });

    await expect(
      streamStructured({
        model: {} as any,
        modelId: "test/model",
        messages: [],
        stage: "synthesize",
        onDelta: () => {},
      }),
    ).rejects.toThrow(/synthesize stream failed: provider stalled/);
  });

  it("passes maxTokens and an AbortSignal through to streamText", async () => {
    const streamStructured = await importStream();
    nextResult.value = makeResult({ deltas: [], finishReason: "stop" });

    await streamStructured({
      model: {} as any,
      modelId: "test/model",
      messages: [],
      stage: "synthesize",
      onDelta: () => {},
      maxTokens: 4242,
      timeoutMs: 50_000,
    });

    expect(captured.args.maxTokens).toBe(4242);
    expect(captured.args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(typeof captured.args.onError).toBe("function");
  });
});
