const API_BASE =
  import.meta.env.PUBLIC_AGENTIC_API_BASE ?? "http://127.0.0.1:8001";

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

export async function startChat({ brief, categories, minYear, mustInclude, skipClarify }) {
  const body = { brief };
  if (categories && categories.length) body.categories = categories;
  if (minYear != null && minYear !== "") body.minYear = Number(minYear);
  if (mustInclude && mustInclude.length) body.mustInclude = mustInclude;
  if (skipClarify) body.skipClarify = true;

  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat start failed (${res.status}): ${text}`);
  }
  return res.json(); // { id }
}

// Phase B — answer a blocking clarifier question; the run resumes on the same SSE stream.
export async function replyChat(id, answer) {
  const res = await fetch(`${API_BASE}/chat/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reply failed (${res.status}): ${text}`);
  }
  return res.json(); // { ok: true }
}
