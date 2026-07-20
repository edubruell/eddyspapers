import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "../env.js";

// The shared MVP password may arrive either as `Authorization: Bearer <pw>` (used by
// fetch calls) or `x-agentic-key: <pw>`. EventSource can't set headers, so the SSE
// stream route is deliberately left ungated — run IDs are unguessable UUIDs and the
// LLM spend is incurred at the POST routes this middleware protects.
function presentedToken(c: Parameters<MiddlewareHandler>[0]): string | null {
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = c.req.header("x-agentic-key");
  return x ? x.trim() : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!env.AGENTIC_PASSWORD) return next(); // gate disabled
  const token = presentedToken(c);
  if (!token || !constantTimeEqual(token, env.AGENTIC_PASSWORD)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};
