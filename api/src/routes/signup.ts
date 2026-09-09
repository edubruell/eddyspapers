import { Hono } from "hono";
import { z } from "zod";
import { getAppDataDb } from "../db/singleton.js";
import { getKeyRegistry, generateKey } from "../auth/keys.js";
import { revokeToken, revokeTokenId, revokeTokenMatches } from "../auth/revokeToken.js";
import { getMailer } from "../mail/mailer.js";
import { keyMail, DELIVERY_NOTE, SUPPORT_EMAIL } from "../mail/keyMail.js";
import type { Scope } from "../db/appdata.js";

// Public self-serve MCP key minting (public_access/01_signup_site.md). The ONLY route that
// creates a key without an admin credential, so two rules are structural rather than
// configurable:
//
//   1. The scope set is hardcoded here. A caller cannot ask for 'rest' (the website login),
//      'admin', or 'lit_search_synth' (the ~10c synthesis stage) — those words never reach
//      db.createKey from this file.
//   2. The plaintext key is NEVER in the HTTP response; it exists only in the mail (D1).
//      That is what makes the address verified in one round trip with no state machine, and
//      it is why the throttle below is keyed on the mailbox.

const PUBLIC_SCOPES: Scope[] = ["mcp", "lit_search"];
// Hourly ceilings, well under the operator key. Only classes named here are narrowed.
const PUBLIC_RATE_LIMITS = { lit_search: 10, find_papers: 120, find_people: 120 };

// D6 throttle. The scarce resource is a deliverable mailbox, not an address block — ZEW,
// DIW and LISER all NAT, so an IP bucket would block the success case (a seminar signing up
// together) while barely inconveniencing a script.
const COOLDOWN_MIN = 10;      // one mail per address per 10 minutes...
const DAILY_PER_ADDRESS = 3;  // ...and three a day, so the form is not a mail-bomb button
const GLOBAL_HOURLY = 60;     // circuit breaker: a flood must not burn the sender's reputation

const signupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  institution: z.string().trim().max(200).optional(),
});

export const signupRoute = new Hono();

signupRoute.post("/key", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const { name, email, institution } = parsed.data;

  const mailer = getMailer();
  if (!mailer.configured) {
    return c.json({ error: `Key delivery is not configured on this server. Write to ${SUPPORT_EMAIL}.` }, 503);
  }

  const db = await getAppDataDb();

  if ((await db.countMailSends(60)) >= GLOBAL_HOURLY) {
    return c.json({ error: `Too many signups right now. Please try again later, or write to ${SUPPORT_EMAIL}.` }, 503);
  }
  if ((await db.countMailSends(COOLDOWN_MIN, email)) > 0) {
    return c.json(
      {
        error:
          `A key mail already went to this address in the last ${COOLDOWN_MIN} minutes. ` +
          `Check your inbox and spam folder. ${DELIVERY_NOTE}`,
      },
      429,
    );
  }
  if ((await db.countMailSends(60 * 24, email)) >= DAILY_PER_ADDRESS) {
    return c.json({ error: `Daily limit for this address reached. Write to ${SUPPORT_EMAIL} and I will send you a key.` }, 429);
  }

  // One active key per mailbox. The plaintext of the old key is unrecoverable (only its
  // digest is stored), so "resend" necessarily means ROTATE: mint a new key, and retire the
  // old one only once the new one is safely in the relay's hands.
  const existing = await db.activeKeyByEmail(email);
  const kind = existing ? "resend" : "key";

  const { key, keyHash } = generateKey();
  await db.createKey({
    keyHash,
    label: `signup:${email}`,
    scopes: PUBLIC_SCOPES,
    rateLimitOverrides: PUBLIC_RATE_LIMITS,
    tools: null,
    name,
    email,
    institution: institution ?? null,
  });

  // Recorded BEFORE the send, so a failing relay cannot be looped into a mail bomb: the
  // cooldown counts attempts, not successes.
  await db.recordMailSend(email, kind);

  const revokeUrl = `${new URL(c.req.url).origin}/signup/revoke?token=${revokeToken(keyHash)}`;
  try {
    await mailer.send(keyMail({ to: email, name, key, revokeUrl, kind }));
  } catch (e) {
    // Nothing usable was delivered — do not leave a key nobody holds sitting active.
    await db.revokeKey(keyHash.slice(0, 12));
    await getKeyRegistry().ensureFresh(true);
    return c.json(
      { error: `Could not send the key mail (${(e as Error).message}). Please write to ${SUPPORT_EMAIL}.` },
      502,
    );
  }

  // The relay accepted it: the mailbox exists, which is as much proof as D1 asks for.
  await db.markKeyVerified(keyHash);
  if (existing) await db.revokeKey(existing.keyHash.slice(0, 12));
  await getKeyRegistry().ensureFresh(true);

  return c.json(
    {
      status: "sent",
      email,
      rotated: kind === "resend",
      scopes: PUBLIC_SCOPES,
      // Enough to recognise the key in a support mail; not enough to use it.
      id: keyHash.slice(0, 12),
      // The fallback has to be visible HERE, on the one screen someone sees while the mail is
      // still in flight — a notice inside a mail that never arrives helps nobody.
      message: `The key is on its way to ${email}. It is not shown here, so check your inbox and spam folder. ${DELIVERY_NOTE}`,
    },
    201,
  );
});

// Resolve a revoke token to its key row. Not-found and bad-mac are one answer, so the route
// cannot be used to test whether a given key id exists.
async function keyHashForToken(token: string): Promise<string | null> {
  const id = revokeTokenId(token);
  if (!id) return null;
  const db = await getAppDataDb();
  const rows = await db.query(
    "SELECT key_hash FROM api_keys WHERE key_hash LIKE ? AND revoked_at IS NULL LIMIT 1",
    [`${id}%`],
  );
  const keyHash = rows[0]?.key_hash as string | undefined;
  if (!keyHash || !revokeTokenMatches(token, keyHash)) return null;
  return keyHash;
}

// GET renders a confirmation form rather than revoking: mail clients and link scanners
// prefetch URLs, and a scanner must not be able to kill someone's key by looking at it.
signupRoute.get("/revoke", async (c) => {
  const token = c.req.query("token") ?? "";
  const ok = (await keyHashForToken(token)) != null;
  const body = ok
    ? `<h1>Revoke this key?</h1>
       <p>This deletes the key and the name, address and institution stored with it.</p>
       <form method="post" action="/signup/revoke">
         <input type="hidden" name="token" value="${token.replace(/[^0-9a-f.]/g, "")}">
         <button type="submit">Revoke my key</button>
       </form>`
    : `<h1>Link not valid</h1><p>This key may already have been revoked or replaced.</p>`;
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Revoke key</title>
     <body style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
    ok ? 200 : 404,
  );
});

signupRoute.post("/revoke", async (c) => {
  const form = c.req.header("content-type")?.includes("json")
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries(await c.req.formData());
  const token = String(form.token ?? "");

  const keyHash = await keyHashForToken(token);
  if (!keyHash) return c.json({ error: "Link not valid. This key may already have been revoked." }, 404);

  const db = await getAppDataDb();
  await db.revokeKey(keyHash.slice(0, 12));
  // GDPR delete path (item 7): the signup identity goes with the key, not just the grant.
  await db.query(
    "UPDATE api_keys SET name = NULL, email = NULL, email_canonical = NULL, institution = NULL WHERE key_hash = ?",
    [keyHash],
  );
  await getKeyRegistry().ensureFresh(true);
  return c.json({ revoked: true });
});
