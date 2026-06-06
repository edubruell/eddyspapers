import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CoreMessage } from "ai";

// buildUserMessage is not exported, so we observe the <clarification> block
// through the user message that writeScript hands to generateStructured.
// generateStructured and checkScript are mocked: no live LLM, no R sandbox.

const generateStructured = vi.fn();
const checkScript = vi.fn();

vi.mock("../../src/llm/structured.js", () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
}));
vi.mock("../../src/sandbox/checkScript.js", () => ({
  checkScript: (...args: unknown[]) => checkScript(...args),
}));
vi.mock("../../src/agent/models.js", () => ({
  models: { writer: {}, writerRetry: {} },
  modelIds: { writer: "stub/writer", writerRetry: "stub/writer-retry" },
}));
vi.mock("../../src/llm/client.js", () => ({
  or: () => ({}),
}));

function lastUserMessage(): string {
  const call = generateStructured.mock.calls.at(-1)?.[0] as { messages: CoreMessage[] };
  const userMsg = call.messages.find((m) => m.role === "user");
  return typeof userMsg?.content === "string" ? userMsg.content : "";
}

const brief = "recent top-5 labour papers and their unique selling point post 2023";

describe("writeScript <clarification> block injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateStructured.mockResolvedValue({
      object: { strategy: "sweep top journals", script: "x <- 1" },
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    });
    checkScript.mockResolvedValue({ ok: true });
  });

  it("injects a <clarification> block when both question and answer are present", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    const result = await writeScript({
      brief,
      dbDate: "2026-06-01",
      clarifyQuestion: "USP relative to what?",
      clarifyAnswer: "Identification strategy",
    });
    expect(result.ok).toBe(true);

    const msg = lastUserMessage();
    expect(msg).toContain("<clarification>");
    expect(msg).toContain("Q: USP relative to what?");
    expect(msg).toContain("A: Identification strategy");
    expect(msg).toContain("</clarification>");
    // The block sits between the brief and the filters block.
    expect(msg.indexOf("</brief>")).toBeLessThan(msg.indexOf("<clarification>"));
    expect(msg.indexOf("</clarification>")).toBeLessThan(msg.indexOf("<filters>"));
  });

  it("omits the block entirely when no clarification was collected", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    await writeScript({ brief, dbDate: "2026-06-01" });
    const msg = lastUserMessage();
    expect(msg).not.toContain("<clarification>");
  });

  it("omits the block when only the question is present (answer missing)", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    await writeScript({ brief, dbDate: "2026-06-01", clarifyQuestion: "USP relative to what?" });
    const msg = lastUserMessage();
    expect(msg).not.toContain("<clarification>");
  });

  it("omits the block when only the answer is present (question missing)", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    await writeScript({ brief, dbDate: "2026-06-01", clarifyAnswer: "Identification strategy" });
    const msg = lastUserMessage();
    expect(msg).not.toContain("<clarification>");
  });

  it("re-injects the clarification on a validation retry (block survives across attempts)", async () => {
    // First attempt fails validation, second passes — both messages must carry the block.
    checkScript
      .mockResolvedValueOnce({ ok: false, reason: "forbidden call", offendingNode: "system", hint: "no system()" })
      .mockResolvedValueOnce({ ok: true });

    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    const result = await writeScript({
      brief,
      dbDate: "2026-06-01",
      clarifyQuestion: "USP relative to what?",
      clarifyAnswer: "Novel data",
    });
    expect(result.ok).toBe(true);
    expect(generateStructured).toHaveBeenCalledTimes(2);

    const firstCall = generateStructured.mock.calls[0][0] as { messages: CoreMessage[] };
    const secondCall = generateStructured.mock.calls[1][0] as { messages: CoreMessage[] };
    const firstUser = firstCall.messages.find((m) => m.role === "user")?.content as string;
    const secondUser = secondCall.messages.find((m) => m.role === "user")?.content as string;

    expect(firstUser).toContain("A: Novel data");
    expect(secondUser).toContain("A: Novel data");
    // The retry also carries the rejection feedback.
    expect(secondUser).toContain("<rejection>");
  });
});
