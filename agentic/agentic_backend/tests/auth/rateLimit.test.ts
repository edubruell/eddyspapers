import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter, LIMITS } from "../../src/auth/rateLimit.js";

// Deterministic clock — the limiter reads Date.now() for window rollover.
function at(ms: number): void {
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

afterEach(() => vi.restoreAllMocks());

describe("RateLimiter", () => {
  it("passes through unknown classes with no bookkeeping", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 1000; i++) expect(rl.tryAcquire("k", "not-a-class").ok).toBe(true);
  });

  it("enforces the single-concurrent lit_search cap and frees it on release", () => {
    const rl = new RateLimiter();
    expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
    const blocked = rl.tryAcquire("k", "lit_search");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
    rl.release("k", "lit_search");
    expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
  });

  it("scopes concurrency per key — one key's slot does not block another", () => {
    const rl = new RateLimiter();
    expect(rl.tryAcquire("a", "lit_search").ok).toBe(true);
    expect(rl.tryAcquire("b", "lit_search").ok).toBe(true);
  });

  it("enforces the hourly cap and resets on the next hour window", () => {
    at(0);
    const rl = new RateLimiter();
    const cap = LIMITS.lit_search.perHour!;
    for (let i = 0; i < cap; i++) {
      expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
      rl.release("k", "lit_search");
    }
    const over = rl.tryAcquire("k", "lit_search");
    expect(over.ok).toBe(false);
    // Roll into the next hour → quota refreshed.
    at(3_600_000);
    expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
  });

  it("enforces the daily cap independent of the hourly window", () => {
    at(0);
    const rl = new RateLimiter();
    const perDay = LIMITS.lit_search.perDay!;
    // Lift the hourly ceiling via an override so only the daily cap can bite; hold the
    // clock at t=0 so every acquire lands in the same day window.
    const over = { lit_search: perDay * 10 };
    let count = 0;
    for (let i = 0; i < perDay + 5; i++) {
      const g = rl.tryAcquire("k", "lit_search", over);
      if (!g.ok) break;
      count += 1;
      rl.release("k", "lit_search");
    }
    expect(count).toBe(perDay);
  });

  it("applies a per-key hourly override in place of the class default", () => {
    at(0);
    const rl = new RateLimiter();
    expect(rl.tryAcquire("k", "find_papers", { find_papers: 1 }).ok).toBe(true);
    expect(rl.tryAcquire("k", "find_papers", { find_papers: 1 }).ok).toBe(false);
    // A different key is unaffected.
    expect(rl.tryAcquire("other", "find_papers", { find_papers: 1 }).ok).toBe(true);
  });

  it("release never drops the gauge below zero", () => {
    const rl = new RateLimiter();
    rl.release("k", "lit_search");
    rl.release("k", "lit_search");
    expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
  });

  it("reset() clears all counters", () => {
    const rl = new RateLimiter();
    rl.tryAcquire("k", "lit_search");
    rl.reset();
    // Concurrency slot was cleared, so a fresh acquire succeeds without a release.
    expect(rl.tryAcquire("k", "lit_search").ok).toBe(true);
  });
});
