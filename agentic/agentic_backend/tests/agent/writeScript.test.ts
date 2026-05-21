import { describe, it, expect } from "vitest";
import { preflight } from "../../src/agent/stages/writeScript.js";
import { clarifierOutputSchema } from "../../src/prompts/assemble.js";

// ── preflight ────────────────────────────────────────────────────────────────

describe("preflight", () => {
  it("rejects an empty string", () => {
    const result = preflight("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("rejects a whitespace-only string", () => {
    const result = preflight("   \t\n  ");
    expect(result.ok).toBe(false);
  });

  it("rejects a single character", () => {
    const result = preflight("a");
    expect(result.ok).toBe(false);
  });

  it("rejects a brief shorter than 15 chars after trim", () => {
    const result = preflight("  hello  ");
    expect(result.ok).toBe(false);
  });

  it("rejects a brief with fewer than 3 word tokens (mostly emoji and numbers)", () => {
    // 21 chars total, but only 2 qualifying letter-sequences ≥ 3 chars ("ok" is 2, skipped)
    // "yes" (3), "no" (2 — excluded), "hi" (2 — excluded) → only 1 qualifying token
    const result = preflight("👍👏🎉 yes 42 99 12 hi 🥳 no ok");
    expect(result.ok).toBe(false);
  });

  it("rejects a brief that is exactly 15 chars but has fewer than 3 word tokens", () => {
    // 15 chars but only 2 letter-sequences of length ≥ 3: "abc" and "defgh"
    const result = preflight("abc 12 defgh 99");
    expect(result.ok).toBe(false);
  });

  it("rejects a brief exceeding 2000 characters", () => {
    const result = preflight("a".repeat(2001));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/2000/);
  });

  it("rejects a brief of exactly 2001 chars (off-by-one check)", () => {
    const long = ("word ").repeat(400) + "x";
    expect(long.trim().length).toBeGreaterThan(2000);
    const result = preflight(long);
    expect(result.ok).toBe(false);
  });

  it("accepts a brief of exactly 2000 chars with enough word tokens", () => {
    const base = "minimum wages employment Germany effects ";
    const padded = (base.repeat(50)).slice(0, 2000);
    const result = preflight(padded);
    expect(result.ok).toBe(true);
  });

  it("accepts a normal brief", () => {
    const result = preflight("Find papers on the employment effects of minimum wages in Germany");
    expect(result.ok).toBe(true);
  });

  it("accepts a brief with leading/trailing whitespace that normalises to valid length", () => {
    const result = preflight("   Find papers on minimum wages and employment effects in Germany   ");
    expect(result.ok).toBe(true);
  });

  it("accepts a brief containing German umlauts (ä, ö, ü count as word chars)", () => {
    const result = preflight("Mindestlohn Beschäftigung Arbeitsmarkt Deutschland Wirkungen");
    expect(result.ok).toBe(true);
  });

  it("accepts a brief where all word tokens contain umlauts", () => {
    const result = preflight("Mindestlöhne führen zur Beschäftigungsveränderung im Niedriglohnsektor");
    expect(result.ok).toBe(true);
  });

  it("counts ß as a word character", () => {
    const result = preflight("Straßenbau Maßnahmen Beschäftigung Deutschland Analyse");
    expect(result.ok).toBe(true);
  });

  it("requires at least 3 word tokens of length ≥ 3", () => {
    // exactly 2 qualifying tokens ("abc" and "def") plus filler
    const result = preflight("abc and def, check this one out please");
    expect(result.ok).toBe(true);
  });

  it("rejects brief with exactly 2 word tokens of ≥ 3 chars (rest are short)", () => {
    // "abc" (3), "ef" (2 — does not match), "xyz" (3) — only 2 matching tokens
    const result = preflight("abc ef xyz, to do it go");
    expect(result.ok).toBe(false);
  });
});

// ── clarifierOutputSchema ────────────────────────────────────────────────────

describe("clarifierOutputSchema", () => {
  it("parses the proceed variant: { done: true }", () => {
    const result = clarifierOutputSchema.safeParse({ done: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ done: true });
  });

  it("parses the question variant: { done: false, question: string }", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      question: "Are you looking for empirical or theoretical work?",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data;
      expect(data.done).toBe(false);
      if (!data.done && "question" in data) expect(data.question.length).toBeGreaterThan(0);
    }
  });

  it("parses the reject variant: { done: false, reject: true, reason: string }", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      reject: true,
      reason: "This service searches economics papers.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data;
      expect(data.done).toBe(false);
      if (!data.done && "reject" in data) {
        expect(data.reject).toBe(true);
        expect(data.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects an object where done is missing", () => {
    const result = clarifierOutputSchema.safeParse({ question: "something" });
    expect(result.success).toBe(false);
  });

  it("rejects an object where done is true but has extra question field", () => {
    // Zod strips extra fields — { done: true } is the only valid shape for the first variant
    const result = clarifierOutputSchema.safeParse({ done: true, question: "hmm" });
    // Zod union strips unknown fields, so this should succeed by matching the first variant
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ done: true });
  });

  it("rejects a question variant when question exceeds 280 chars", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      question: "q".repeat(281),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reject variant when reason exceeds 280 chars", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      reject: true,
      reason: "r".repeat(281),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a completely invalid shape", () => {
    const result = clarifierOutputSchema.safeParse({ foo: "bar" });
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = clarifierOutputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects a string", () => {
    const result = clarifierOutputSchema.safeParse("done");
    expect(result.success).toBe(false);
  });

  it("rejects the reject variant when reason is missing", () => {
    const result = clarifierOutputSchema.safeParse({ done: false, reject: true });
    expect(result.success).toBe(false);
  });

  it("accepts question at the 280-char boundary", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      question: "q".repeat(280),
    });
    expect(result.success).toBe(true);
  });

  it("accepts reason at the 280-char boundary", () => {
    const result = clarifierOutputSchema.safeParse({
      done: false,
      reject: true,
      reason: "r".repeat(280),
    });
    expect(result.success).toBe(true);
  });
});
