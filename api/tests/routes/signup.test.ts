import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import type { MailMessage } from "../../src/mail/mailer.js";

// The public mint route. Two properties are load-bearing and are asserted from several
// angles: the plaintext key exists ONLY in the mail, and the throttle is keyed on the
// mailbox (never the IP — institutions NAT, see D6).

let tmp: string;
let sent: MailMessage[];
let app: Hono;
let sendImpl: (m: MailMessage) => Promise<void>;

async function boot(opts: { configured?: boolean } = {}): Promise<void> {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", "boot");
  vi.stubEnv("SEARCH_ID_SECRET", "test-secret-for-revoke-tokens");
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  const { setMailer } = await import("../../src/mail/mailer.js");
  setMailer({
    configured: opts.configured ?? true,
    async send(m) {
      await sendImpl(m);
      sent.push(m);
    },
  });
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
}

const signup = (body: Record<string, unknown>) =>
  app.request("/signup/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// The cooldown is the point of a later test; most tests need more than one signup, so they
// clear the ledger explicitly rather than waiting ten minutes.
const clearMailLog = async () => {
  const { getAppDataDb } = await import("../../src/db/singleton.js");
  await (await getAppDataDb()).query("DELETE FROM key_mail_log");
};

const keyRows = async () => {
  const { getAppDataDb } = await import("../../src/db/singleton.js");
  return (await getAppDataDb()).query("SELECT * FROM api_keys ORDER BY created_at");
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-signup-"));
  sent = [];
  sendImpl = async () => undefined;
  await boot();
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  const { setMailer } = await import("../../src/mail/mailer.js");
  setMailer(null);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /signup/key", () => {
  it("mints a key, mails it, and never puts the plaintext in the response", async () => {
    const res = await signup({ name: "Ada L.", email: "ada@zew.de", institution: "ZEW" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe("sent");
    expect(body.rotated).toBe(false);
    expect(sent).toHaveLength(1);

    // Nowhere in the response — not under a different name, not nested.
    const key = sent[0].text.match(/esk_[A-Za-z0-9_-]+/)?.[0];
    expect(key).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(key!);
  });

  it("tells the reader where a human is, on the screen AND in the mail", async () => {
    const res = await signup({ name: "Ada", email: "ada@zew.de" });
    // The screen is the only place a fallback helps when the mail is the thing that fails.
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/24 hours/);
    expect(body.message).toMatch(/eduard\.bruell@zew\.de/);
    expect(sent[0].text).toMatch(/eduard\.bruell@zew\.de/);
  });

  it("points at a human when the throttle refuses, not just at a limit", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const again = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(((await again.json()) as { error: string }).error).toMatch(/eduard\.bruell@zew\.de/);
  });

  it("the mail carries everything needed to use the key (it cannot be re-sent)", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const text = sent[0].text;
    expect(text).toMatch(/claude mcp add --transport http eddysearch/);
    expect(text).toMatch(/Authorization: Bearer esk_/);
    expect(text).toMatch(/\/signup\/revoke\?token=[0-9a-f]{12}\.[0-9a-f]{32}/);
  });

  it("hardcodes the public scope set — never rest, admin or lit_search_synth", async () => {
    const res = await signup({ name: "Ada", email: "ada@zew.de", scopes: ["admin", "rest"] });
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(["mcp", "lit_search"]);
    const row = (await keyRows())[0];
    expect(JSON.parse(row.scopes as string)).toEqual(["mcp", "lit_search"]);
  });

  it("stores the signup identity and marks the mailbox verified once the relay accepts", async () => {
    await signup({ name: "Ada L.", email: "Ada+Tag@ZEW.de", institution: "ZEW" });
    const row = (await keyRows())[0];
    expect(row.name).toBe("Ada L.");
    expect(row.email).toBe("ada+tag@zew.de");
    expect(row.email_canonical).toBe("ada@zew.de"); // the throttle axis, plus-tag stripped
    expect(row.institution).toBe("ZEW");
    expect(row.verified_at).not.toBeNull();
  });

  it("rejects a malformed body", async () => {
    expect((await signup({ name: "", email: "nope" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("D6 throttle — keyed on the mailbox", () => {
  it("holds off a second mail to the same address inside the cooldown", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const again = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it("sees through case and plus-tags — the same mailbox cannot be mail-bombed", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const again = await signup({ name: "Ada", email: "Ada+conference@ZEW.de" });
    expect(again.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it("does not throttle a DIFFERENT address (colleagues signing up together must work)", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const other = await signup({ name: "Bob", email: "bob@zew.de" });
    expect(other.status).toBe(201);
    expect(sent).toHaveLength(2);
  });

  it("caps one address per day even with the cooldown elapsed", async () => {
    const { getAppDataDb } = await import("../../src/db/singleton.js");
    const db = await getAppDataDb();
    // Three sends today, all older than the cooldown window.
    await db.query(
      "INSERT INTO key_mail_log (email_canonical, kind, sent_at) SELECT 'ada@zew.de', 'key', now() - INTERVAL 2 HOUR FROM range(3)",
    );
    const res = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/Daily limit/) });
  });

  it("trips the global circuit breaker without singling out an institution", async () => {
    const { getAppDataDb } = await import("../../src/db/singleton.js");
    const db = await getAppDataDb();
    await db.query(
      "INSERT INTO key_mail_log (email_canonical, kind, sent_at) SELECT 'flood' || i || '@x.de', 'key', now() FROM range(60) t(i)",
    );
    const res = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});

describe("one active key per mailbox", () => {
  it("rotates rather than minting a second: new key mailed, old one revoked", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    await clearMailLog();
    const res = await signup({ name: "Ada", email: "ada@zew.de" });

    expect(res.status).toBe(201);
    expect((await res.json()) as { rotated: boolean }).toMatchObject({ rotated: true });
    expect(sent[1].subject).toMatch(/new eddysearch MCP key/);
    expect(sent[1].text).toMatch(/previous key has been revoked/);

    const rows = await keyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at).not.toBeNull(); // the first one
    expect(rows[1].revoked_at).toBeNull();
  });
});

describe("failure modes", () => {
  it("revokes the key it just minted when the mail cannot be sent", async () => {
    sendImpl = async () => {
      throw new Error("relay refused");
    };
    const res = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(res.status).toBe(502);

    const rows = await keyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull(); // no key nobody holds is left active
    expect(rows[0].verified_at).toBeNull();
  });

  it("still burns the cooldown on a failed send, so a dead relay is not a mail-bomb loop", async () => {
    sendImpl = async () => {
      throw new Error("relay refused");
    };
    await signup({ name: "Ada", email: "ada@zew.de" });
    sendImpl = async () => undefined;
    expect((await signup({ name: "Ada", email: "ada@zew.de" })).status).toBe(429);
  });

  it("refuses to mint at all when no mailer is configured (the key would have nowhere to go)", async () => {
    await boot({ configured: false });
    const res = await signup({ name: "Ada", email: "ada@zew.de" });
    expect(res.status).toBe(503);
    expect(await keyRows()).toHaveLength(0);
  });
});

describe("/signup/revoke", () => {
  const tokenFromMail = () => sent.at(-1)!.text.match(/token=([0-9a-f]{12}\.[0-9a-f]{32})/)![1];

  it("GET renders a confirm form instead of revoking (link scanners prefetch)", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const res = await app.request(`/signup/revoke?token=${tokenFromMail()}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<form method="post"/);
    expect((await keyRows())[0].revoked_at).toBeNull(); // still live
  });

  it("POST revokes the key and erases the stored identity (GDPR delete path)", async () => {
    await signup({ name: "Ada", email: "ada@zew.de", institution: "ZEW" });
    const res = await app.request("/signup/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tokenFromMail() }),
    });
    expect(res.status).toBe(200);

    const row = (await keyRows())[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
    expect(row.email_canonical).toBeNull();
    expect(row.institution).toBeNull();
  });

  it("refuses a forged mac on a real key id — the id alone is not enough", async () => {
    await signup({ name: "Ada", email: "ada@zew.de" });
    const id = tokenFromMail().split(".")[0];
    const res = await app.request("/signup/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `${id}.${"0".repeat(32)}` }),
    });
    expect(res.status).toBe(404);
    expect((await keyRows())[0].revoked_at).toBeNull();
  });

  it("answers a bogus token exactly as it answers an unknown one (no key-id oracle)", async () => {
    const bogus = await app.request("/signup/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `${"a".repeat(12)}.${"b".repeat(32)}` }),
    });
    expect(bogus.status).toBe(404);
    expect(await bogus.json()).toEqual({ error: expect.stringMatching(/not valid/) });
  });
});
