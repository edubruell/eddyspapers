import { Hono } from "hono";
import { z } from "zod";
import { getAppDataDb, reloadCorpusDb } from "../db/singleton.js";
import { getKeyRegistry, generateKey } from "../auth/keys.js";
import { requireKey } from "../middleware/requireKey.js";
import { ALL_SCOPES, type Scope } from "../db/appdata.js";
import { MCP_TOOL_NAMES } from "../mcp/tools.js";
import { SCOPE_DOCS } from "../docs/reference.js";

// Admin surface for the API-key registry (PLAN.md §D1). The `scripts/keys.ts` CLI drives
// these over HTTP so only the server process ever opens appdata.duckdb (its cross-process
// lock is exclusive). Every route needs the 'admin' scope — bootstrapped in prod by the
// grandfathered AGENTIC_PASSWORD (all-scope), and open in dev when no gate is configured.
//
// The minted plaintext key is returned ONCE, on create — it is never stored (only its
// SHA-256 digest is), so it cannot be recovered afterwards.

const DEFAULT_SCOPES: Scope[] = ["rest", "mcp"];

const scopeEnum = z.enum(["rest", "mcp", "lit_search", "lit_search_synth", "admin"]);

const scopesSchema = z.object({
  scopes: z.array(scopeEnum).min(1),
});

const createSchema = z.object({
  label: z.string().min(1).max(200),
  scopes: z.array(scopeEnum).min(1).optional(),
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

// Re-scope an existing key in place. The plaintext is never recoverable, so re-minting to
// change a grant would mean chasing every holder for a swap — this grants (or withdraws) a
// scope on the key someone already has. Scopes are REPLACED wholesale, not merged, so the
// caller sends the full intended set.
adminRoute.patch("/keys/:prefix", async (c) => {
  const prefix = c.req.param("prefix").trim();
  if (prefix.length < 4) return c.json({ error: "Provide at least 4 hex chars of the key id/hash" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = scopesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const db = await getAppDataDb();
  const updated = await db.setKeyScopes(prefix, parsed.data.scopes as Scope[]);
  await getKeyRegistry().ensureFresh(true);
  if (updated.length === 0) return c.json({ error: "No active key matched that prefix" }, 404);

  return c.json({
    updated: updated.map((k) => ({ id: k.keyHash.slice(0, 12), label: k.label, scopes: k.scopes })),
  });
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

// Erase one mailbox from the signup system: its keys and its send ledger both go, so the
// address is as it was before anyone signed up. Two uses, one implementation — replaying a
// signup while testing (a revoke alone leaves the cooldown and the daily cap in the way), and
// honouring a deletion request. The address travels in the BODY, not the path or query, so it
// stays out of access logs.
const purgeSchema = z.object({ email: z.string().email() });

adminRoute.post("/signups/purge", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = purgeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const db = await getAppDataDb();
  const purged = await db.purgeSignup(parsed.data.email);
  await getKeyRegistry().ensureFresh(true);
  return c.json({ purged });
});

adminRoute.get("/keys", async (c) => {
  const includeRevoked = c.req.query("all") === "1" || c.req.query("all") === "true";
  const db = await getAppDataDb();
  const keys = await db.listKeys(includeRevoked);
  return c.json({
    scopes: ALL_SCOPES,
    // The console renders these verbatim, so what a scope grants is stated once, server-side.
    scope_docs: SCOPE_DOCS,
    available_tools: MCP_TOOL_NAMES,
    keys: keys.map((k) => ({
      id: k.keyHash.slice(0, 12),
      label: k.label,
      scopes: k.scopes,
      rate_limit_overrides: k.rateLimitOverrides,
      tools: k.tools,
      // Self-serve signup identity — NULL for every operator-minted key, so the console can
      // tell "someone signed up" from "I minted this" at a glance.
      name: k.name,
      email: k.email,
      institution: k.institution,
      verified_at: k.verifiedAt,
      created_at: k.createdAt,
      revoked_at: k.revokedAt,
    })),
  });
});
