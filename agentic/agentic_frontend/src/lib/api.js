const API_BASE =
  import.meta.env.PUBLIC_AGENTIC_API_BASE ?? "http://127.0.0.1:8001";

// The classic (non-agentic) semantic-search API. Used only to read the shared
// database snapshot date, exactly as the semantic frontend does via /stats/last_updated.
const SEMANTIC_API_BASE =
  import.meta.env.PUBLIC_SEMANTIC_API_BASE ?? "https://econpapers.eduard-bruell.de/api";

export function streamUrl(id) {
  return `${API_BASE}/chat/${encodeURIComponent(id)}/stream`;
}

export async function getLastUpdated({ signal } = {}) {
  const res = await fetch(`${SEMANTIC_API_BASE}/stats/last_updated`, { signal });
  if (!res.ok) throw new Error(`last_updated failed (${res.status})`);
  return res.json(); // { last_updated }
}

export async function startChat({ brief, categories, minYear, mustInclude }) {
  const body = { brief };
  if (categories && categories.length) body.categories = categories;
  if (minYear != null && minYear !== "") body.minYear = Number(minYear);
  if (mustInclude && mustInclude.length) body.mustInclude = mustInclude;

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
