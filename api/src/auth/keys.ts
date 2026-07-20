import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getAppDataDb } from "../db/singleton.js";
import { ALL_SCOPES, type AppDataDb, type ApiKeyRow, type Scope } from "../db/appdata.js";

// The API-key registry (PLAN.md §D1). Keys are minted with `esk_<random>`; only their
// SHA-256 digest is ever stored. A running request presents the plaintext key as a
// Bearer token / x-api-key header; we hash it and match against the cached digest set.
//
// The legacy shared password (AGENTIC_PASSWORD) is grandfathered as an all-scope key so
// the ZEW preview keeps working through the transition — matched in constant time,
// never hashed into the registry.

export const KEY_PREFIX = "esk_";

export interface KeyIdentity {
  // Stable identifier used to bucket rate limits + attribute spend. For real keys this is
  // the first 12 hex of the hash; the grandfathered password is "legacy".
  id: string;
  label: string;
  scopes: Scope[];
  rateLimitOverrides: Record<string, number> | null;
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateKey(): { key: string; keyHash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keyHash: hashKey(key) };
}

// Read the grandfathered shared password live (like appdata.ts reads its path) rather than
// off the module-frozen env, so the gate can be toggled at runtime and in tests without
// import-order gymnastics.
const legacyPassword = (): string => process.env.AGENTIC_PASSWORD ?? "";

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const rowToIdentity = (r: ApiKeyRow): KeyIdentity => ({
  id: r.keyHash.slice(0, 12),
  label: r.label,
  scopes: r.scopes,
  rateLimitOverrides: r.rateLimitOverrides,
});

const LEGACY_IDENTITY: KeyIdentity = {
  id: "legacy",
  label: "legacy-password",
  scopes: [...ALL_SCOPES],
  rateLimitOverrides: null,
};

const RELOAD_TTL_MS = 30_000;

export class KeyRegistry {
  private byHash = new Map<string, KeyIdentity>();
  private lastLoad = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly open: () => Promise<AppDataDb>) {}

  private async reload(): Promise<void> {
    const db = await this.open();
    const rows = await db.activeKeys();
    this.byHash = new Map(rows.map((r) => [r.keyHash, rowToIdentity(r)]));
    this.lastLoad = Date.now();
  }

  // Refresh the digest cache if the TTL has lapsed. Concurrent callers share one reload.
  async ensureFresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastLoad < RELOAD_TTL_MS) return;
    if (!this.loading) {
      this.loading = this.reload().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  // The gate is active once a password is set OR any key has been provisioned; otherwise
  // requests pass through ungated (dev convenience, mirroring the old requireAuth).
  isEnabled(): boolean {
    return legacyPassword() !== "" || this.byHash.size > 0;
  }

  // Resolve a presented token to an identity, or null if unknown/revoked. Scope
  // enforcement is the caller's job (so it can distinguish 401 from 403).
  verify(token: string | null): KeyIdentity | null {
    if (!token) return null;
    const pw = legacyPassword();
    if (pw !== "" && constantTimeEqual(token, pw)) {
      return LEGACY_IDENTITY;
    }
    return this.byHash.get(hashKey(token)) ?? null;
  }
}

let singleton: KeyRegistry | null = null;

export function getKeyRegistry(): KeyRegistry {
  if (!singleton) singleton = new KeyRegistry(getAppDataDb);
  return singleton;
}

// Test hook: drop the cached registry so the next getKeyRegistry() rebuilds against a
// freshly-pointed AGENTIC_APPDATA_PATH.
export function resetKeyRegistry(): void {
  singleton = null;
}
