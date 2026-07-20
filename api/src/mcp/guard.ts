import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getRateLimiter } from "../auth/rateLimit.js";
import type { KeyIdentity } from "../auth/keys.js";

// Rate-limit wrapper for the cheap MCP tools (PLAN.md §D1). A null key means the gate is
// disabled (dev) or a keyless local stdio build — no limiting applies. Otherwise the
// call reserves one unit against the key's per-class window and releases any concurrency
// slot afterwards (a no-op for classes without a concurrency cap).
export async function withRateLimit(
  key: KeyIdentity | null,
  cls: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (!key) return fn();
  const limiter = getRateLimiter();
  const gate = limiter.tryAcquire(key.id, cls, key.rateLimitOverrides);
  if (!gate.ok) {
    return { content: [{ type: "text", text: gate.reason }], isError: true };
  }
  try {
    return await fn();
  } finally {
    limiter.release(key.id, cls);
  }
}
