// Normalisation for the SQL-route parity comparator (PLAN.md §12.1, phase-5 M5).
//
// Plumber and Hono disagree on two systematic, harmless things:
//   1. Boxing — Plumber's `@serializer json` is auto_unbox=FALSE, so LIST endpoints wrap every
//      scalar field in a one-element array ({"handle":["x"]}); Hono returns clean scalars.
//   2. Precision — jsonlite serialises doubles at digits=4; Hono returns full precision.
// Applying the SAME transform to BOTH sides collapses those differences without hiding real
// ones: recursively unwrap one-element arrays (a boxed scalar and a genuine 1-row result array
// both unwrap identically on both sides, so a true count/shape difference still shows up), round
// every number to 4 decimals, and drop volatile keys (timestamps, ids, hashes) that legitimately
// differ between a recording and a live diff.

const VOLATILE = new Set([
  "created_at",
  "timestamp",
  "recorded_at",
  "response_time_ms",
  "search_id",
  "hash", // saved-search hashes use different algorithms across stacks (compare results, not hash)
]);

const round4 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n);

export function normalizeForParity(v: unknown): unknown {
  if (Array.isArray(v)) {
    // Collapse a one-element array to its (normalised) element — this is what unifies Plumber's
    // boxed scalars with Hono's scalars, and it is applied to both sides so 1-row result arrays
    // stay comparable.
    if (v.length === 1) return normalizeForParity(v[0]);
    return v.map(normalizeForParity);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalizeForParity(val);
    }
    return out;
  }
  if (typeof v === "bigint") return round4(Number(v));
  if (typeof v === "number") return round4(v);
  return v;
}

// Structural deep-equality on already-normalised values. Returns a short path to the first
// difference, or null when equal.
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      const d = firstDiff(ao[k], bo[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
