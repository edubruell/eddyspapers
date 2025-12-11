const API_BASE = "http://127.0.0.1:8000";

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function getLastUpdated() {
    const res = await fetch(`${API_BASE}/stats/last_updated`);
    if (!res.ok) {
        throw new Error(`Failed to load last_updated`);
    }
    return res.json();   // returns { last_updated: "YYYY-MM-DD" }
}

export async function saveSearch(payload) {
    const res = await fetch(`${API_BASE}/search/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${msg}`);
    }

    return res.json();        // returns { hash, results }
}

export async function loadSavedSearch(hash) {
    const res = await fetch(`${API_BASE}/search/${hash}`);

    if (!res.ok) {
        throw new Error(`Search not found`);
    }

    return res.json();       // returns { hash, query, ..., results }
}

export async function getVersions(handle) {
    const url = `${API_BASE}/versions?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load versions for ${handle}`);
    }
    return res.json();     // array of version objects
}

export async function getCitedBy(handle, limit = 50) {
    const url = `${API_BASE}/citedby?handle=${encodeURIComponent(handle)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load citedby for ${handle}`);
    }
    return res.json();     // array of papers citing this handle
}

export async function getCites(handle, limit = 50) {
    const url = `${API_BASE}/cites?handle=${encodeURIComponent(handle)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load cites for ${handle}`);
    }
    return res.json();     // array of papers this handle cites
}

export async function getCitationCounts(handle) {
    const url = `${API_BASE}/citationcounts?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load citation counts for ${handle}`);
    }
    return res.json();     // { total, internal }
}

export async function getHandleStats(handle) {
    const url = `${API_BASE}/handlestats?handle=${encodeURIComponent(handle)}`;
    const res = await fetch(url);

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Failed to load handle stats for ${handle}: ${text}`);
    }

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
