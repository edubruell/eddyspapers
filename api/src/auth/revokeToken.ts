import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

// Revocation link for a self-serve key (D4), and with it the GDPR delete path. The token is
// DERIVED from the key hash under the server-only SEARCH_ID_SECRET rather than stored, so it
// needs no column and no second appdata migration; the same secret already guards run ids.
// Shape: <12-hex key id>.<32-hex mac> — the id locates the row, the mac proves the holder
// got the link from the key mail rather than guessing a prefix.

const ID_LEN = 12;
const MAC_LEN = 32;

const mac = (keyHash: string): string =>
  createHmac("sha256", env.SEARCH_ID_SECRET).update(`revoke:${keyHash}`).digest("hex").slice(0, MAC_LEN);

export const revokeToken = (keyHash: string): string => `${keyHash.slice(0, ID_LEN)}.${mac(keyHash)}`;

// The full hash is needed to recompute the mac, so the caller resolves the id to a row first.
export function revokeTokenMatches(token: string, keyHash: string): boolean {
  const [, presented] = token.split(".");
  if (!presented || presented.length !== MAC_LEN) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(mac(keyHash)));
}

// The id half, validated as hex so it can be pasted into a LIKE prefix without escaping.
export function revokeTokenId(token: string): string | null {
  const id = token.split(".")[0] ?? "";
  return /^[0-9a-f]{12}$/.test(id) ? id : null;
}
