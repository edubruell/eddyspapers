import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// Route-level tests drive the real app via app.request() against the fixture DB.
// DB_SNAPSHOT must be set before the corpus singleton first opens; AGENTIC_PASSWORD
// stays unset so the gate is disabled (gate behaviour is covered by
// tests/middleware/auth.test.ts).
let app: Hono;

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /papers/keyword", () => {
  it("returns totals and rows for a valid body", async () => {
    const res = await post("/papers/keyword", { keywords: ["minimum wage"], limit: 3 });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; results: { Handle: string }[] };
    expect(data.total).toBeGreaterThan(0);
    expect(data.results.length).toBe(3);
  });

  it("rejects an empty keyword list", async () => {
    const res = await post("/papers/keyword", { keywords: [] });
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields values", async () => {
    const res = await post("/papers/keyword", { keywords: ["wage"], fields: ["bib_tex"] });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const res = await app.request("/papers/keyword", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range limit and offset", async () => {
    expect((await post("/papers/keyword", { keywords: ["wage"], limit: 0 })).status).toBe(400);
    expect((await post("/papers/keyword", { keywords: ["wage"], limit: 501 })).status).toBe(400);
    expect((await post("/papers/keyword", { keywords: ["wage"], offset: -1 })).status).toBe(400);
  });

  it("rejects more than 20 keywords", async () => {
    const keywords = Array.from({ length: 21 }, (_, i) => `kw${i}`);
    const res = await post("/papers/keyword", { keywords });
    expect(res.status).toBe(400);
  });

  it("rejects keywords that are empty or whitespace-only after trim", async () => {
    expect((await post("/papers/keyword", { keywords: [""] })).status).toBe(400);
    expect((await post("/papers/keyword", { keywords: ["   "] })).status).toBe(400);
    expect((await post("/papers/keyword", { keywords: ["wage", " \t "] })).status).toBe(400);
  });

  it("trims surrounding whitespace off keywords before searching", async () => {
    const trimmed = await post("/papers/keyword", { keywords: ["minimum wage"], limit: 1 });
    const padded = await post("/papers/keyword", { keywords: ["  minimum wage  "], limit: 1 });
    expect(padded.status).toBe(200);
    const a = (await trimmed.json()) as { total: number };
    const b = (await padded.json()) as { total: number };
    expect(b.total).toBe(a.total);
  });

  it("strips unknown body fields (zod default — a future .strict() change must update this)", async () => {
    const res = await post("/papers/keyword", {
      keywords: ["minimum wage"],
      limit: 1,
      bogus_field: "ignored",
      another: { nested: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number };
    expect(data.total).toBeGreaterThan(0);
  });

  it("rejects wrong types (limit as string, keywords as string)", async () => {
    expect((await post("/papers/keyword", { keywords: ["wage"], limit: "10" })).status).toBe(400);
    expect((await post("/papers/keyword", { keywords: "wage" })).status).toBe(400);
  });

  it("accepts journal_name as a comma-separated string", async () => {
    const res = await post("/papers/keyword", {
      keywords: ["minimum wage"],
      journal_name: "American Economic Review, Journal of Labor",
      limit: 10,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: { journal: string | null }[] };
    data.results.forEach((r) => {
      expect(
        /american economic review|journal of labor/i.test(r.journal ?? ""),
      ).toBe(true);
    });
  });
});

describe("POST /papers/verify", () => {
  it("verifies a batch and reports per-entry status", async () => {
    const res = await post("/papers/verify", {
      entries: [
        { author_lastnames: "Dube; Lester; Reich", year: 2010, title: "Minimum Wage Effects Across State Borders" },
        { author_lastnames: "Zzyzx", year: 1999, title: "Fictional Nonexistent Paper" },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: { status: string }[] };
    expect(data.results.map((r) => r.status)).toEqual(["fuzzy_match", "not_found"]);
  });

  it("rejects an oversized batch", async () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({ cite_key: `k${i}` }));
    const res = await post("/papers/verify", { entries });
    expect(res.status).toBe(400);
  });

  it("rejects a year sent as a string", async () => {
    const res = await post("/papers/verify", {
      entries: [{ author_lastnames: "Dube", year: "2010", title: "Minimum Wage Effects" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer year", async () => {
    const res = await post("/papers/verify", {
      entries: [{ author_lastnames: "Dube", year: 2010.5, title: "Minimum Wage Effects" }],
    });
    expect(res.status).toBe(400);
  });

  it("accepts an all-empty entry (every field nullish) and reports not_found", async () => {
    const res = await post("/papers/verify", { entries: [{}] });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: { status: string; paper: unknown }[] };
    expect(data.results).toEqual([
      { entry: {}, status: "not_found", paper: null, stats: null, mismatches: [] },
    ]);
  });

  it("rejects an empty entries array", async () => {
    const res = await post("/papers/verify", { entries: [] });
    expect(res.status).toBe(400);
  });
});

describe("GET /corpus/guide", () => {
  it("serves the guide without auth", async () => {
    const res = await app.request("/corpus/guide");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total_articles: number; categories: unknown[] };
    expect(data.total_articles).toBeGreaterThan(0);
    expect(data.categories.length).toBe(7);
  });
});
