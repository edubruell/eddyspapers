const API_BASE =
  import.meta.env.PUBLIC_AGENTIC_API_BASE ?? "http://127.0.0.1:8001";

const KEY_STORAGE = "agentic_key";

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode / storage disabled — auth simply won't persist */
  }
}

// Bearer header for the gated POST routes. Omitted when no key is stored (the backend
// passes through when AGENTIC_PASSWORD is unset, so dev still works headerless).
function authHeaders(key = getKey()) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Probe the gate with a candidate key (or the stored one). 200 → authorised (or gate
// disabled); 401 → wrong/absent password. Used by the login screen.
export async function checkAuth(key = getKey(), { signal } = {}) {
  const res = await fetch(`${API_BASE}/auth/check`, { headers: authHeaders(key), signal });
  return res.ok;
}

export function streamUrl(id) {
  return `${API_BASE}/chat/${encodeURIComponent(id)}/stream`;
}

// Read-only fetch of a stored run for share links (08_sharelinks.md). Ungated — no auth
// header needed; returns { id, brief, status, createdAt, minYear, categories, events }.
export async function getSharedSearch(id, { signal } = {}) {
  const res = await fetch(`${API_BASE}/searches/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Couldn't load this search (${res.status}).`);
  return res.json();
}

// The DB snapshot date comes from the agentic backend, which proxies the shared
// semantic-search API server-side (the key never reaches the browser).
export async function getLastUpdated({ signal } = {}) {
  const res = await fetch(`${API_BASE}/stats/last_updated`, { signal });
  if (!res.ok) throw new Error(`last_updated failed (${res.status})`);
  return res.json(); // { last_updated }
}

export async function startChat({ brief, categories, minYear, mustInclude, skipClarify, refine }) {
  const body = { brief };
  if (categories && categories.length) body.categories = categories;
  if (minYear != null && minYear !== "") body.minYear = Number(minYear);
  if (mustInclude && mustInclude.length) body.mustInclude = mustInclude;
  if (skipClarify) body.skipClarify = true;
  if (refine) body.refine = true;

  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat start failed (${res.status}): ${text}`);
  }
  return res.json(); // { id }
}

// Server-rendered XLSX of the collected sources (one row per paper). Returns a Blob the
// caller saves; throws on a non-2xx (e.g. 401 if the password changed mid-session).
export async function exportXlsx(papers) {
  const res = await fetch(`${API_BASE}/export/xlsx`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ papers }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Excel export failed (${res.status}): ${text}`);
  }
  return res.blob();
}

// ── Admin: API-key registry (/admin/keys, requireKey('admin')) ────────────────────────
// The admin token is stored separately from the search-app key so a colleague using the
// search UI never carries admin rights. In dev (no password, no keys) the backend passes
// requireKey('admin') through, so listAdminKeys returns 200 with an empty list and the page
// opens without a token.

const ADMIN_KEY_STORAGE = "agentic_admin_key";

export function getAdminKey() {
  try {
    return localStorage.getItem(ADMIN_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setAdminKey(key) {
  try {
    if (key) localStorage.setItem(ADMIN_KEY_STORAGE, key);
    else localStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    /* private mode / storage disabled — the token simply won't persist */
  }
}

async function adminReq(method, path, { token = getAdminKey(), body, signal } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text().catch(() => "");
  // Tolerate a non-JSON body (e.g. an HTML 502/504 from the reverse proxy) — the caller keys
  // on `status`, and JSON.parse throwing here would mask it with a "Unexpected token" error.
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

// Attach the HTTP status to a thrown admin error so callers can drop to the lock screen on
// 401/403 (an admin token can be revoked between the initial list and a later mint/revoke).
function adminError(status, data, fallback) {
  const err = new Error(data?.error ? JSON.stringify(data.error) : fallback);
  err.status = status;
  return err;
}

// List keys. Returns { scopes, keys } on success; throws with a 401/403 marker so the page
// can drop to its lock screen. `all` includes revoked keys.
export async function listAdminKeys({ token, all = false, signal } = {}) {
  const { ok, status, data } = await adminReq("GET", `/admin/keys${all ? "?all=1" : ""}`, {
    token,
    signal,
  });
  if (!ok) throw adminError(status, data, `list failed (${status})`);
  return data; // { scopes, keys: [{ id, label, scopes, rate_limit_overrides, created_at, revoked_at }] }
}

// Mint a key. The plaintext in the response is the ONLY time it exists — never recoverable.
// `tools` is the MCP tool allowlist: pass an array to restrict, or omit/undefined for all tools
// (the backend stores null = every tool). An empty array means "no cheap tools".
export async function createAdminKey({ label, scopes, tools, token } = {}) {
  const { ok, status, data } = await adminReq("POST", "/admin/keys", {
    token,
    body: {
      label,
      ...(scopes && scopes.length ? { scopes } : {}),
      ...(tools !== undefined ? { tools } : {}),
    },
  });
  if (!ok) throw adminError(status, data, `create failed (${status})`);
  return data; // { key, key_hash, id, label, scopes, tools }
}

export async function revokeAdminKey(prefix, { token } = {}) {
  const { ok, status, data } = await adminReq("DELETE", `/admin/keys/${encodeURIComponent(prefix)}`, {
    token,
  });
  if (!ok) throw adminError(status, data, `revoke failed (${status})`);
  return data; // { revoked }
}

// Phase B — answer a blocking clarifier question; the run resumes on the same SSE stream.
export async function replyChat(id, answer) {
  const res = await fetch(`${API_BASE}/chat/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reply failed (${res.status}): ${text}`);
  }
  return res.json(); // { ok: true }
}
