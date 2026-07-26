import { Hono } from "hono";
import { z } from "zod";
import { getAppDataDb, reloadCorpusDb } from "../db/singleton.js";
import { getKeyRegistry, generateKey } from "../auth/keys.js";
import { requireKey } from "../middleware/requireKey.js";
import { ALL_SCOPES, type Scope } from "../db/appdata.js";
import { MCP_TOOL_NAMES } from "../mcp/tools.js";

// Admin surface for the API-key registry (PLAN.md §D1). The `scripts/keys.ts` CLI drives
// these over HTTP so only the server process ever opens appdata.duckdb (its cross-process
// lock is exclusive). Every route needs the 'admin' scope — bootstrapped in prod by the
// grandfathered AGENTIC_PASSWORD (all-scope), and open in dev when no gate is configured.
//
// The minted plaintext key is returned ONCE, on create — it is never stored (only its
// SHA-256 digest is), so it cannot be recovered afterwards.

const DEFAULT_SCOPES: Scope[] = ["rest", "mcp"];

const createSchema = z.object({
  label: z.string().min(1).max(200),
  scopes: z.array(z.enum(["rest", "mcp", "lit_search", "admin"])).min(1).optional(),
  rate_limit_overrides: z.record(z.number().int().positive()).nullish(),
  // MCP tool allowlist (M9 G). Omitted / null = all tools; a validated subset otherwise.
  // An empty array is allowed (an mcp key exposing no cheap tools — lit_search still rides
  // its own scope). Unknown tool names are rejected by the enum.
  tools: z.array(z.enum(MCP_TOOL_NAMES)).nullish(),
});

export const adminRoute = new Hono();

adminRoute.use("*", requireKey("admin"));

adminRoute.post("/keys", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const scopes = (parsed.data.scopes as Scope[] | undefined) ?? DEFAULT_SCOPES;
  const tools = parsed.data.tools ? [...parsed.data.tools] : (parsed.data.tools ?? null);
  const { key, keyHash } = generateKey();
  const db = await getAppDataDb();
  await db.createKey({
    keyHash,
    label: parsed.data.label,
    scopes,
    rateLimitOverrides: parsed.data.rate_limit_overrides ?? null,
    tools,
  });
  await getKeyRegistry().ensureFresh(true);

  // The one and only time the plaintext key crosses the wire.
  return c.json({ key, key_hash: keyHash, id: keyHash.slice(0, 12), label: parsed.data.label, scopes, tools }, 201);
});

adminRoute.delete("/keys/:prefix", async (c) => {
  const prefix = c.req.param("prefix").trim();
  if (prefix.length < 4) return c.json({ error: "Provide at least 4 hex chars of the key id/hash" }, 400);
  const db = await getAppDataDb();
  const revoked = await db.revokeKey(prefix);
  await getKeyRegistry().ensureFresh(true);
  if (revoked === 0) return c.json({ error: "No active key matched that prefix" }, 404);
  return c.json({ revoked });
});

// Reopen the corpus after a pipeline snapshot swap (PLAN.md §6 decision 4). The deploy
// script curls this once the atomic rename is in place; a failed reopen keeps the old pool
// serving and surfaces as a 500 so the operator notices.
adminRoute.post("/reload", async (c) => {
  const snapshot = await reloadCorpusDb();
  return c.json({
    reloaded: true,
    snapshot: { path: snapshot.path, ageMs: snapshot.ageMs, stale: snapshot.stale },
  });
});

adminRoute.get("/keys", async (c) => {
  const includeRevoked = c.req.query("all") === "1" || c.req.query("all") === "true";
  const db = await getAppDataDb();
  const keys = await db.listKeys(includeRevoked);
  return c.json({
    scopes: ALL_SCOPES,
    available_tools: MCP_TOOL_NAMES,
    keys: keys.map((k) => ({
      id: k.keyHash.slice(0, 12),
      label: k.label,
      scopes: k.scopes,
      rate_limit_overrides: k.rateLimitOverrides,
      tools: k.tools,
      created_at: k.createdAt,
      revoked_at: k.revokedAt,
    })),
  });
});
