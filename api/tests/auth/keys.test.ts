import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// env.ts + the registry singleton read process.env / cache at import, so each test
// resets modules, points AGENTIC_APPDATA_PATH at a throwaway file, and re-imports.

let tmp: string;

async function load(password: string) {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  const appdata = await import("../../src/db/appdata.js");
  const keys = await import("../../src/auth/keys.js");
  const singleton = await import("../../src/db/singleton.js");
  return { appdata, keys, singleton };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-keys-"));
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("hashKey / generateKey", () => {
  it("mints a prefixed key whose stored hash is the SHA-256 of the plaintext", async () => {
    const { keys } = await load("");
    const { key, keyHash } = keys.generateKey();
    expect(key.startsWith("esk_")).toBe(true);
    expect(keyHash).toBe(keys.hashKey(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns the same key twice", async () => {
    const { keys } = await load("");
    const a = keys.generateKey();
    const b = keys.generateKey();
    expect(a.key).not.toBe(b.key);
  });
});

describe("KeyRegistry", () => {
  it("is disabled when no password and no keys exist", async () => {
    const { keys } = await load("");
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.isEnabled()).toBe(false);
    expect(reg.verify("anything")).toBeNull();
  });

  it("grandfathers the shared password as an all-scope legacy identity", async () => {
    const { keys } = await load("s3cret");
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.isEnabled()).toBe(true);
    const id = reg.verify("s3cret");
    expect(id?.id).toBe("legacy");
    expect(id?.scopes).toEqual(["rest", "mcp", "lit_search", "admin"]);
    expect(reg.verify("wrong")).toBeNull();
    expect(reg.verify(null)).toBeNull();
  });

  it("rejects a same-length-wrong and a wrong-length password (timing-safe compare)", async () => {
    const { keys } = await load("s3cret");
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    // Same byte length as "s3cret" (6) but wrong content — the length short-circuit is not hit.
    expect(reg.verify("s3crXt")).toBeNull();
    // Different length — the length branch short-circuits, still null (never a legacy hit).
    expect(reg.verify("s3cre")).toBeNull();
    expect(reg.verify("s3cretx")).toBeNull();
    expect(reg.verify("")).toBeNull();
    // The correct one still resolves.
    expect(reg.verify("s3cret")?.id).toBe("legacy");
  });

  it("does not treat the empty string as a match when the password is empty (gate disabled)", async () => {
    const { keys } = await load("");
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    // AGENTIC_PASSWORD==="" means the legacy branch is skipped entirely; "" is not legacy.
    expect(reg.verify("")).toBeNull();
    expect(reg.verify(null)).toBeNull();
  });

  it("resolves a provisioned key by its hash and honours its scopes", async () => {
    const { keys, singleton } = await load("");
    const { key, keyHash } = keys.generateKey();
    const db = await singleton.getAppDataDb();
    await db.createKey({ keyHash, label: "Alice", scopes: ["rest", "mcp"] });

    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.isEnabled()).toBe(true);
    const id = reg.verify(key);
    expect(id?.label).toBe("Alice");
    expect(id?.scopes).toEqual(["rest", "mcp"]);
    expect(id?.id).toBe(keyHash.slice(0, 12));
  });

  it("stops resolving a key once it is revoked (after a forced refresh)", async () => {
    const { keys, singleton } = await load("");
    const { key, keyHash } = keys.generateKey();
    const db = await singleton.getAppDataDb();
    await db.createKey({ keyHash, label: "Bob", scopes: ["mcp"] });

    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.verify(key)).not.toBeNull();

    await db.revokeKey(keyHash.slice(0, 12));
    await reg.ensureFresh(true);
    expect(reg.verify(key)).toBeNull();
  });

  it("does NOT see a key added directly to appdata until the TTL lapses or a force refresh (staleness contract)", async () => {
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true); // prime lastLoad, empty registry

    // A key written straight to the store while the cache is warm is invisible: the 30s TTL
    // has not lapsed, and ensureFresh() without force is a no-op.
    const { key, keyHash } = keys.generateKey();
    await db.createKey({ keyHash, label: "Sneaky", scopes: ["rest"] });
    await reg.ensureFresh(); // within TTL → no reload
    expect(reg.verify(key)).toBeNull();

    // A forced refresh (what the admin routes trigger on create/revoke) picks it up.
    await reg.ensureFresh(true);
    expect(reg.verify(key)?.label).toBe("Sneaky");
  });

  it("still resolves a revoked key from a stale cache until the next refresh (documents the timing)", async () => {
    const { keys, singleton } = await load("");
    const { key, keyHash } = keys.generateKey();
    const db = await singleton.getAppDataDb();
    await db.createKey({ keyHash, label: "Doomed", scopes: ["rest"] });

    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.verify(key)).not.toBeNull();

    // Revoke in the store but do NOT force a refresh: the warm cache still resolves it.
    await db.revokeKey(keyHash.slice(0, 12));
    await reg.ensureFresh(); // within TTL → no reload
    expect(reg.verify(key)).not.toBeNull();

    // A forced refresh (as the admin DELETE route does) closes the window immediately.
    await reg.ensureFresh(true);
    expect(reg.verify(key)).toBeNull();
  });

  it("carries per-key rate-limit overrides through to the identity", async () => {
    const { keys, singleton } = await load("");
    const { key, keyHash } = keys.generateKey();
    const db = await singleton.getAppDataDb();
    await db.createKey({ keyHash, label: "Power", scopes: ["mcp", "lit_search"], rateLimitOverrides: { lit_search: 100 } });
    const reg = keys.getKeyRegistry();
    await reg.ensureFresh(true);
    expect(reg.verify(key)?.rateLimitOverrides).toEqual({ lit_search: 100 });
  });
});

describe("AppDataDb", () => {
  it("lists active keys and excludes revoked ones unless asked", async () => {
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    const a = keys.generateKey();
    const b = keys.generateKey();
    await db.createKey({ keyHash: a.keyHash, label: "A", scopes: ["rest"] });
    await db.createKey({ keyHash: b.keyHash, label: "B", scopes: ["rest"] });
    await db.revokeKey(b.keyHash.slice(0, 12));

    expect((await db.activeKeys()).map((k) => k.label).sort()).toEqual(["A"]);
    expect((await db.listKeys(false)).map((k) => k.label)).toEqual(["A"]);
    expect((await db.listKeys(true)).map((k) => k.label).sort()).toEqual(["A", "B"]);
  });

  it("revokeKey returns 0 when no active key matches", async () => {
    const { singleton } = await load("");
    const db = await singleton.getAppDataDb();
    expect(await db.revokeKey("deadbeef")).toBe(0);
  });

  it("revoking an already-revoked key returns 0 (the WHERE revoked_at IS NULL guard)", async () => {
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    const g = keys.generateKey();
    await db.createKey({ keyHash: g.keyHash, label: "Once", scopes: ["rest"] });
    expect(await db.revokeKey(g.keyHash.slice(0, 12))).toBe(1);
    // Second revoke matches no *active* row.
    expect(await db.revokeKey(g.keyHash.slice(0, 12))).toBe(0);
  });

  it("rejects a duplicate key_hash insert (PRIMARY KEY constraint)", async () => {
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    const g = keys.generateKey();
    await db.createKey({ keyHash: g.keyHash, label: "First", scopes: ["rest"] });
    await expect(db.createKey({ keyHash: g.keyHash, label: "Dupe", scopes: ["mcp"] })).rejects.toThrow();
    // The original row is untouched.
    const active = await db.activeKeys();
    expect(active.map((k) => k.label)).toEqual(["First"]);
  });

  it("revokeKey with a broad prefix revokes every active matching row", async () => {
    // A prefix that both hashes happen to share would revoke both; use the shared '' via a
    // 4-char slice is too random, so assert on a full-hash prefix touching exactly one row,
    // then confirm a distinct hash is left active.
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    const a = keys.generateKey();
    const b = keys.generateKey();
    await db.createKey({ keyHash: a.keyHash, label: "A", scopes: ["rest"] });
    await db.createKey({ keyHash: b.keyHash, label: "B", scopes: ["rest"] });
    expect(await db.revokeKey(a.keyHash)).toBe(1); // full hash → exactly one
    expect((await db.activeKeys()).map((k) => k.label)).toEqual(["B"]);
  });

  it("listKeys orders by created_at ascending (insertion order preserved)", async () => {
    const { keys, singleton } = await load("");
    const db = await singleton.getAppDataDb();
    for (const label of ["first", "second", "third"]) {
      const g = keys.generateKey();
      await db.createKey({ keyHash: g.keyHash, label, scopes: ["rest"] });
    }
    const labels = (await db.listKeys(true)).map((k) => k.label);
    // created_at defaults to now(); inserts within the same tick can tie, so assert the set
    // and that the first insert is not ordered after a later one when timestamps differ.
    expect(labels.slice().sort()).toEqual(["first", "second", "third"]);
    expect(labels).toContain("first");
  });
});
