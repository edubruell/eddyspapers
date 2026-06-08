const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "http://127.0.0.1:8000";
const API_KEY = import.meta.env.PUBLIC_API_KEY;

function apiHeaders(json = true) {
  const h = { "X-API-Key": API_KEY };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function check(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res;
}

export async function searchPersons({
  query,
  scoringMode = "breadth",
  qualityWeight = 0.3,
  limit = 25,
  offset = 0,
  minYear = null,
  category = null,
  institution = null,
  activeSince = null,
  minCitations = null,
}) {
  const payload = {
    query,
    scoring_mode: scoringMode,
    quality_weight: qualityWeight,
    limit,
    offset,
    min_year: minYear || null,
    category: category && category.length ? category.join(",") : null,
    institution: institution || null,
    active_since: activeSince || null,
    min_citations: minCitations || null,
  };
  const res = await fetch(`${API_BASE}/person/search`, {
    method: "POST",
    headers: apiHeaders(true),
    body: JSON.stringify(payload),
  });
  await check(res);
  return res.json();
}

export async function savePersonSearch({
  query,
  scoringMode,
  qualityWeight,
  results,
}) {
  const res = await fetch(`${API_BASE}/person/search/save`, {
    method: "POST",
    headers: apiHeaders(true),
    body: JSON.stringify({ query, scoring_mode: scoringMode, quality_weight: qualityWeight, results }),
  });
  await check(res);
  return res.json();
}

export async function loadPersonSearch(hash) {
  const res = await fetch(`${API_BASE}/person/search/${hash}`, {
    headers: apiHeaders(false),
  });
  await check(res);
  return res.json();
}

export async function getPersonProfile(shortId) {
  const res = await fetch(`${API_BASE}/person/${encodeURIComponent(shortId)}`, {
    headers: apiHeaders(false),
  });
  await check(res);
  return res.json();
}
