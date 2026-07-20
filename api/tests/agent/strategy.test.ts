import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent, StreamEventPayload } from "../../src/agent/types.js";

// ── strategy is part of the StreamEvent taxonomy ──────────────────────────────

describe("strategy StreamEvent", () => {
  it("is a valid StreamEvent variant carrying type, seq, strategy", () => {
    const e: StreamEvent = { type: "strategy", seq: 3, strategy: "I'll search the top journals." };
    expect(e.type).toBe("strategy");
    expect(e.seq).toBe(3);
    expect(e.strategy).toContain("top journals");
    // strategy events do NOT carry a stage field on the union
    expect("stage" in e).toBe(false);
  });

  it("StreamEventPayload omits seq from the strategy variant", () => {
    const payload: StreamEventPayload = { type: "strategy", strategy: "plan" };
    expect("seq" in payload).toBe(false);
    expect(payload.type).toBe("strategy");
  });
});

// ── writeScript surfaces the strategy from the LLM output ──────────────────────
// Hermetic: generateStructured and checkScript are mocked — no live LLM, no R.

vi.mock("../../src/llm/structured.js", () => ({
  generateStructured: vi.fn(),
}));
vi.mock("../../src/sandbox/checkScript.js", () => ({
  checkScript: vi.fn(),
}));

describe("writeScript strategy surfacing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with both script and strategy when validation passes", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    const { generateStructured } = await import("../../src/llm/structured.js");
    const { checkScript } = await import("../../src/sandbox/checkScript.js");

    vi.mocked(generateStructured).mockResolvedValueOnce({
      object: {
        strategy: "I'll sweep the top journals for minimum-wage employment work, favouring well-cited papers.",
        script: "all_handles <- character(0)\nemit_bibtex(all_handles)",
      },
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 80 },
    } as never);
    vi.mocked(checkScript).mockResolvedValueOnce({ ok: true } as never);

    const result = await writeScript({
      brief: "Find papers on the employment effects of minimum wages in Germany",
      dbDate: "2025-01-15",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toContain("top journals");
      expect(result.script).toContain("emit_bibtex");
      expect(result.attempts).toBe(1);
    }
  });

  it("carries the strategy from the final accepted attempt after a retry", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");
    const { generateStructured } = await import("../../src/llm/structured.js");
    const { checkScript } = await import("../../src/sandbox/checkScript.js");

    vi.mocked(generateStructured)
      .mockResolvedValueOnce({
        object: { strategy: "first plan", script: "system('rm -rf /')" },
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      } as never)
      .mockResolvedValueOnce({
        object: { strategy: "second, clean plan", script: "emit_bibtex(character(0))" },
        usage: { promptTokens: 12, completionTokens: 6, cachedTokens: 0 },
      } as never);

    vi.mocked(checkScript)
      .mockResolvedValueOnce({ ok: false, reason: "shell access", offendingNode: "system", hint: "remove it" } as never)
      .mockResolvedValueOnce({ ok: true } as never);

    const result = await writeScript({
      brief: "Find papers on the employment effects of minimum wages in Germany",
      dbDate: "2025-01-15",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe("second, clean plan");
      expect(result.attempts).toBe(2);
    }
  });

  it("does not surface a strategy when the brief fails preflight", async () => {
    const { writeScript } = await import("../../src/agent/stages/writeScript.js");

    const result = await writeScript({ brief: "too short", dbDate: "2025-01-15" });

    expect(result.ok).toBe(false);
    expect("strategy" in result).toBe(false);
  });
});
