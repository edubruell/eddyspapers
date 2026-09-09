import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { canonicalEmail, openAppDataDb, type AppDataDb } from "../../src/db/appdata.js";

// The self-serve signup migration (public_access/01_signup_site.md step 2): name / email /
// email_canonical / institution / verified_at on api_keys, plus the key_mail_log ledger the
// D6 cooldown counts. Two things have to hold — the ALTERs must survive a cold restart (the
// 2026-07-26 WAL landmine), and the one-key-per-mailbox lookup must treat one mailbox as one
// mailbox however the user typed it.

let tmp = "";
let db: AppDataDb | undefined;

afterEach(async () => {
  if (db) await db.close();
  db = undefined;
  vi.unstubAllEnvs();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

// An api_keys file from before this migration: the columns the ALTERs add are genuinely
// absent, so they do real work rather than no-op.
async function seedPreSignupFile(path: string): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE api_keys (
      key_hash VARCHAR PRIMARY KEY,
      label VARCHAR NOT NULL,
      scopes TEXT NOT NULL,
      rate_limit_overrides TEXT,
      created_at TIMESTAMP DEFAULT now(),
      revoked_at TIMESTAMP
    )
  `);
  await conn.run("INSERT INTO api_keys (key_hash, label, scopes) VALUES ('deadbeef00', 'operator', '[\"admin\"]')");
  await conn.run("CHECKPOINT");
  conn.disconnectSync();
  inst.closeSync();
}

const walSize = async (dbFile: string): Promise<number> => {
  try {
    return (await stat(`${dbFile}.wal`)).size;
  } catch {
    return 0;
  }
};

const openTemp = async (): Promise<AppDataDb> => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-appdata-signup-"));
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  return openAppDataDb();
};

describe("canonicalEmail", () => {
  it("lowercases, trims, and strips the +tag subaddress", () => {
    expect(canonicalEmail("  Eddy+MCP@ZEW.de ")).toBe("eddy@zew.de");
    expect(canonicalEmail("eddy@zew.de")).toBe("eddy@zew.de");
  });

  it("leaves a '+' in the domain alone and tolerates a malformed address", () => {
    expect(canonicalEmail("a@b+c.de")).toBe("a@b+c.de");
    expect(canonicalEmail("notanemail")).toBe("notanemail");
  });
});

describe("the api_keys signup migration", () => {
  it("adds the identity columns to a pre-existing file and leaves no ALTER in the WAL", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-appdata-signup-"));
    const path = join(tmp, "appdata.duckdb");
    await seedPreSignupFile(path);
    vi.stubEnv("AGENTIC_APPDATA_PATH", path);

    db = await openAppDataDb();
    const cols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'",
    );
    const names = cols.map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining(["name", "email", "email_canonical", "institution", "verified_at"]),
    );
    expect(await walSize(path)).toBe(0);
  });

  it("survives a cold reopen, and the pre-existing operator key keeps NULL identity fields", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-appdata-signup-"));
    const path = join(tmp, "appdata.duckdb");
    await seedPreSignupFile(path);
    vi.stubEnv("AGENTIC_APPDATA_PATH", path);

    await (await openAppDataDb()).close();
    db = await openAppDataDb();

    const [operator] = await db.listKeys(false);
    expect(operator.label).toBe("operator");
    expect(operator.email).toBeNull();
    expect(operator.emailCanonical).toBeNull();
    expect(operator.verifiedAt).toBeNull();
  });
});

describe("one key per mailbox", () => {
  it("stores the identity and finds the key however the address was typed", async () => {
    db = await openTemp();
    await db.createKey({
      keyHash: "aaaa1111",
      label: "signup",
      scopes: ["mcp", "lit_search"],
      name: "Eddy Brüll",
      email: "Eddy+MCP@ZEW.de",
      institution: "ZEW",
    });

    const row = await db.activeKeyByEmail("eddy@zew.de");
    expect(row?.keyHash).toBe("aaaa1111");
    expect(row?.name).toBe("Eddy Brüll");
    expect(row?.institution).toBe("ZEW");
    // Mail still goes to the address as given; only the throttle key is canonicalised.
    expect(row?.email).toBe("eddy+mcp@zew.de");
    expect(row?.emailCanonical).toBe("eddy@zew.de");
    expect(row?.verifiedAt).toBeNull();
  });

  it("an operator-minted key (no email) is not findable by mailbox", async () => {
    db = await openTemp();
    await db.createKey({ keyHash: "bbbb2222", label: "operator", scopes: ["admin"] });
    expect(await db.activeKeyByEmail("eddy@zew.de")).toBeNull();
  });

  it("a revoked key frees the mailbox for a fresh signup", async () => {
    db = await openTemp();
    await db.createKey({ keyHash: "cccc3333", label: "s", scopes: ["mcp"], email: "a@zew.de" });
    await db.revokeKey("cccc");
    expect(await db.activeKeyByEmail("a@zew.de")).toBeNull();
  });

  it("markKeyVerified records that the relay accepted the key mail", async () => {
    db = await openTemp();
    await db.createKey({ keyHash: "dddd4444", label: "s", scopes: ["mcp"], email: "b@zew.de" });
    await db.markKeyVerified("dddd4444");
    expect((await db.activeKeyByEmail("b@zew.de"))?.verifiedAt).not.toBeNull();
  });
});

describe("the mail ledger (D6 cooldown + global budget)", () => {
  it("counts per mailbox and route-wide, canonicalising the mailbox", async () => {
    db = await openTemp();
    await db.recordMailSend("Eddy@zew.de", "key");
    await db.recordMailSend("eddy+tag@zew.de", "resend");
    await db.recordMailSend("someone@example.org", "key");

    expect(await db.countMailSends(60, "eddy@zew.de")).toBe(2);
    expect(await db.countMailSends(60, "someone@example.org")).toBe(1);
    // No email = the whole route, which is the circuit breaker.
    expect(await db.countMailSends(60)).toBe(3);
  });

  it("only counts sends inside the window", async () => {
    db = await openTemp();
    await db.run("INSERT INTO key_mail_log (email_canonical, kind, sent_at) VALUES ('old@zew.de', 'key', now() - INTERVAL 2 HOUR)");
    await db.recordMailSend("old@zew.de", "key");

    expect(await db.countMailSends(10, "old@zew.de")).toBe(1);
    expect(await db.countMailSends(180, "old@zew.de")).toBe(2);
  });
});
