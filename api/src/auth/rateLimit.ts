// In-process, per-key rate limiter (PLAN.md §D1, 01_design.md §7.9). No per-IP limiting —
// ZEW NATs everything through one address, so the API key is the only meaningful subject.
// State is module-local and resets on restart; that is acceptable for a small trusted
// preview (a restart grants at most one extra window of quota).
//
// Two axes per tool class:
//   - fixed-window counters (per hour, per day) — cheap, coarse, no sliding-window bookkeeping;
//   - a concurrency gauge — the load-bearing guard for lit_search (real model spend).
// SQL-only tools get a generous hourly ceiling purely as an abuse backstop.

export interface ClassLimit {
  perHour?: number;
  perDay?: number;
  concurrent?: number;
}

export const LIMITS: Record<string, ClassLimit> = {
  lit_search: { perHour: 30, perDay: 300, concurrent: 1 },
  find_papers: { perHour: 600 },
  find_people: { perHour: 600 },
  keyword_search: { perHour: 6000 },
  verify_references: { perHour: 6000 },
  corpus_context: { perHour: 6000 },
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type AcquireResult = { ok: true } | { ok: false; reason: string; retryAfterSec: number };

interface Windowed {
  hourWindow: number;
  hourCount: number;
  dayWindow: number;
  dayCount: number;
  active: number;
}

function emptyState(): Windowed {
  return { hourWindow: -1, hourCount: 0, dayWindow: -1, dayCount: 0, active: 0 };
}

export class RateLimiter {
  private state = new Map<string, Windowed>();

  private get(key: string): Windowed {
    let s = this.state.get(key);
    if (!s) {
      s = emptyState();
      this.state.set(key, s);
    }
    return s;
  }

  // Roll fixed windows forward lazily on access — no background timers, no unbounded growth
  // (a stale row is at most reset, never accumulates across windows).
  private roll(s: Windowed, now: number): void {
    const h = Math.floor(now / HOUR_MS);
    const d = Math.floor(now / DAY_MS);
    if (s.hourWindow !== h) {
      s.hourWindow = h;
      s.hourCount = 0;
    }
    if (s.dayWindow !== d) {
      s.dayWindow = d;
      s.dayCount = 0;
    }
  }

  // Reserve one unit for (keyId, cls). Increments the window counters and, when the class
  // caps concurrency, the active gauge — which the caller MUST release() in a finally.
  // Per-key hourly overrides (from the key row) widen or narrow the hourly ceiling only.
  tryAcquire(keyId: string, cls: string, overrides?: Record<string, number> | null): AcquireResult {
    const limit = LIMITS[cls];
    if (!limit) return { ok: true };

    const now = Date.now();
    const s = this.get(`${keyId}:${cls}`);
    this.roll(s, now);

    const perHour = overrides?.[cls] ?? limit.perHour;

    if (limit.concurrent != null && s.active >= limit.concurrent) {
      return { ok: false, reason: `Too many concurrent ${cls} requests (max ${limit.concurrent}).`, retryAfterSec: 30 };
    }
    if (perHour != null && s.hourCount >= perHour) {
      return { ok: false, reason: `Hourly ${cls} limit reached (${perHour}/h).`, retryAfterSec: secsToNextWindow(now, HOUR_MS) };
    }
    if (limit.perDay != null && s.dayCount >= limit.perDay) {
      return { ok: false, reason: `Daily ${cls} limit reached (${limit.perDay}/day).`, retryAfterSec: secsToNextWindow(now, DAY_MS) };
    }

    s.hourCount += 1;
    s.dayCount += 1;
    if (limit.concurrent != null) s.active += 1;
    return { ok: true };
  }

  // Release a concurrency slot claimed by a successful tryAcquire. No-op for classes
  // without a concurrency cap. Never drops below zero.
  release(keyId: string, cls: string): void {
    if (LIMITS[cls]?.concurrent == null) return;
    const s = this.state.get(`${keyId}:${cls}`);
    if (s && s.active > 0) s.active -= 1;
  }

  reset(): void {
    this.state.clear();
  }
}

function secsToNextWindow(now: number, windowMs: number): number {
  return Math.ceil((windowMs - (now % windowMs)) / 1000);
}

let singleton: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!singleton) singleton = new RateLimiter();
  return singleton;
}
