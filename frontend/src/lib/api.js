const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "/api";
const API_KEY = import.meta.env.PUBLIC_API_KEY;

function apiHeaders(json = true) {
    const h = {
        "X-API-Key": API_KEY
    };
    if (json) {
        h["Content-Type"] = "application/json";
    }
    return h;
}

async function check(res) {
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${text}`);
    }
    return res;
}

export async function searchPapers({
                                       query,
                                       minYear,
                                       journalFilter,
                                       journalName,
                                       titleKeyword,
                                       authorKeyword,
                                       maxK = 100
                                   }) {
    const payload = {
        query,
        max_k: maxK,
        min_year: minYear ? Number(minYear) : null,
        journal_filter: journalFilter && journalFilter.length
            ? journalFilter.join(",")
            : null,
        journal_name: journalName || null,
        title_keyword: titleKeyword || null,
        author_keyword: authorKeyword || null
    };

    const res = await fetch(`${API_BASE}/search`, {
        method: "POST",
        headers: apiHeaders(true),
        body: JSON.stringify(payload)
    });

    await check(res);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function getLastUpdated() {
    const res = await fetch(`${API_BASE}/stats/last_updated`, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function saveSearch(payload) {
    const res = await fetch(`${API_BASE}/search/save`, {
        method: "POST",
        headers: apiHeaders(true),
        body: JSON.stringify(payload)
    });
    await check(res);
    return res.json();
}

export async function loadSavedSearch(hash) {
    const res = await fetch(`${API_BASE}/search/${hash}`, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function getVersions(handle) {
    const url = `${API_BASE}/versions?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function getCitedBy(handle, limit = 50) {
    const url = `${API_BASE}/citedby?handle=${encodeURIComponent(handle)}&limit=${limit}`;
    const res = await fetch(url, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function getCites(handle, limit = 50) {
    const url = `${API_BASE}/cites?handle=${encodeURIComponent(handle)}&limit=${limit}`;
    const res = await fetch(url, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function getCitationCounts(handle) {
    const url = `${API_BASE}/citationcounts?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}

export async function getHandleStats(handle) {
    const url = `${API_BASE}/handlestats?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url, {
        headers: apiHeaders(false)
    });
    await check(res);

    const data = await res.json();
    if (!data || !Array.isArray(data.handle) || data.handle.length === 0) {
        return null;
    }

    const pick = (key) =>
        key in data
            ? (Array.isArray(data[key]) ? data[key][0] : data[key])
            : null;

    const stats = {
        handle: pick("handle"),
        pub_year: pick("pub_year"),
        years_since_pub: pick("years_since_pub"),
        total_citations: pick("total_citations"),
        internal_citations: pick("internal_citations"),
        total_references: pick("total_references"),
        citations_per_year: pick("citations_per_year"),
        citation_percentile: pick("citation_percentile"),
        citations_by_year_raw: pick("citations_by_year"),
        median_citer_percentile: pick("median_citer_percentile"),
        weighted_citations: pick("weighted_citations"),
        top5_citer_share: pick("top5_citer_share"),
        max_citer_percentile: pick("max_citer_percentile"),
        mean_citer_percentile: pick("mean_citer_percentile"),
        top_citing_journal: pick("top_citing_journal"),
        citer_category_counts_raw: pick("citer_category_counts"),
        citer_category_shares_raw: pick("citer_category_shares")
    };

    if (stats.citations_by_year_raw) {
        try {
            stats.citations_by_year = JSON.parse(stats.citations_by_year_raw);
        } catch {
            stats.citations_by_year = null;
        }
    }

    if (stats.citer_category_counts_raw) {
        try {
            stats.citer_category_counts = JSON.parse(stats.citer_category_counts_raw);
        } catch {
            stats.citer_category_counts = null;
        }
    }

    if (stats.citer_category_shares_raw) {
        try {
            stats.citer_category_shares = JSON.parse(stats.citer_category_shares_raw);
        } catch {
            stats.citer_category_shares = null;
        }
    }

    return stats;
}

export async function getJournalStats() {
    const res = await fetch(`${API_BASE}/stats/journals`, {
        headers: apiHeaders(false)
    });
    await check(res);
    return res.json();
}
