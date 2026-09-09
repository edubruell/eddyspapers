import { getSearchDb } from "../db/singleton.js";
import type { KeyIdentity } from "../auth/keys.js";

// Run ownership (security review S6, gating the self-serve key milestone —
// public_access/01_signup_site.md). A stored run is readable through the AUTHENTICATED
// faces — the fetch_search tool and the agenticsearch://searches/{id} resources — only by
// a key that produced it. Before this, any mcp-scoped key could read any run by id, which
// is a cross-tenant read of strangers' briefs and result sets the moment keys self-serve.
//
// The by-id share surfaces (GET /searches/:id and the SSE stream) stay ungated by design
// (agentic/08_sharelinks.md §5); what protects them is that the id is an HMAC under a
// server-only SEARCH_ID_SECRET, so it cannot be re-derived from a known brief.
//
// Two deliberate pass-throughs:
//   - a null key = the gate is disabled (dev) or the local stdio binary, whose caller
//     already has shell access — there is no principal to own anything;
//   - an admin key reads every run, which is also what keeps runs created before this
//     table existed reachable by the operator.
// The grandfathered AGENTIC_PASSWORD identity is all-scope, so the shared-password preview
// users co-own everything — unchanged from today's trust set, and it retires with the
// password.

export async function recordRunOwner(id: string, key: KeyIdentity | null): Promise<void> {
  if (!key) return;
  const db = await getSearchDb();
  await db.recordOwner(id, key.id);
}

export async function ownsRun(id: string, key: KeyIdentity | null): Promise<boolean> {
  if (!key || key.scopes.includes("admin")) return true;
  const db = await getSearchDb();
  return db.isOwner(id, key.id);
}
