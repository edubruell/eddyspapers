import type { Context, MiddlewareHandler } from "hono";
import { getKeyRegistry, type KeyIdentity } from "../auth/keys.js";
import type { Scope } from "../db/appdata.js";

// requireKey(scope) — the scoped-API-key gate that supersedes the shared-password
// requireAuth on the costly routes (PLAN.md §D1). Behaviour matrix:
//   - gate disabled (no password, no keys)  → pass through, apiKey = null (dev)
//   - no / unknown / revoked token           → 401 Unauthorized
//   - known key lacking the required scope   → 403 Forbidden
//   - known key with the scope               → next(), apiKey = identity
// The resolved identity is stashed on the context so downstream handlers (and the MCP
// route) can attribute rate limits + spend without re-parsing the header.

declare module "hono" {
  interface ContextVariableMap {
    apiKey: KeyIdentity | null;
  }
}

function presentedToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = c.req.header("x-api-key") ?? c.req.header("x-agentic-key");
  return x ? x.trim() : null;
}

export function getApiKey(c: Context): KeyIdentity | null {
  return c.get("apiKey") ?? null;
}

export function requireKey(scope: Scope): MiddlewareHandler {
  return async (c, next) => {
    const registry = getKeyRegistry();
    await registry.ensureFresh();

    if (!registry.isEnabled()) {
      c.set("apiKey", null);
      return next();
    }

    const identity = registry.verify(presentedToken(c));
    if (!identity) return c.json({ error: "Unauthorized" }, 401);
    if (!identity.scopes.includes(scope)) {
      return c.json({ error: `Forbidden: key lacks '${scope}' scope` }, 403);
    }

    c.set("apiKey", identity);
    return next();
  };
}
