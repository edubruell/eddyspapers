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
