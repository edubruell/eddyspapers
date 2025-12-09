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
