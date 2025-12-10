import { useState, useEffect } from "react";
import { searchPapers, getLastUpdated, loadSavedSearch, saveSearch} from "../lib/api";
import SearchPanel from "./SearchPanel.jsx";
import Results from "./Results.jsx";

const CATEGORY_DEFS = [
    { id: "top5", label: "Top 5", api: "Top 5 Journals" },
    { id: "general", label: "General Interest", api: "General Interest" },
    { id: "aej", label: "AEJs", api: "AEJs" },
    { id: "topA", label: "Top Field (A)", api: "Top Field Journals (A)" },
    {
        id: "secondB",
        label: "Second in Field (B)",
        api: "Second in Field Journals (B)"
    },
    { id: "other", label: "Other Journals", api: "Other Journals" },
    { id: "wp", label: "Working Paper", api: "Working Paper Series" }
];

export default function SearchApp() {
    const [query, setQuery] = useState("");
    const [minYear, setMinYear] = useState("");
    const [selectedCats, setSelectedCats] = useState([
        "top5",
        "general",
        "aej",
        "topA",
        "secondB"
    ]);
    const [journalName, setJournalName] = useState("");
    const [titleKeyword, setTitleKeyword] = useState("");
    const [authorKeyword, setAuthorKeyword] = useState("");
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [lastSummary, setLastSummary] = useState(null);
    const [hasSearched, setHasSearched] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [restoring, setRestoring] = useState(false);
    const [savedHash, setSavedHash] = useState(null);
    const [maxK, setMaxK] = useState(100);


    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const hash = params.get("search");

        if (!hash) return;

        // small helper to unwrap 1-element arrays coming from the API
        const first = (v) => Array.isArray(v) ? v[0] : v;

        async function restore() {
            setRestoring(true);
            try {
                const saved = await loadSavedSearch(hash);

                const restoredQuery        = first(saved.query) ?? "";
                const restoredMinYearRaw   = first(saved.min_year);
                const restoredJournalName  = first(saved.journal_name) ?? "";
                const restoredTitleKeyword = first(saved.title_keyword) ?? "";
                const restoredAuthorKeyword= first(saved.author_keyword) ?? "";
                const jfRaw                = first(saved.journal_filter) ?? null;

                // normalise minYear ("NA" -> empty)
                const restoredMinYear =
                    restoredMinYearRaw && restoredMinYearRaw !== "NA"
                        ? String(restoredMinYearRaw)
                        : "";

                setQuery(restoredQuery);
                setMinYear(restoredMinYear);
                setJournalName(restoredJournalName);
                setTitleKeyword(restoredTitleKeyword);
                setAuthorKeyword(restoredAuthorKeyword);

                if (jfRaw) {
                    const activeLabels = jfRaw.split(",").map(s => s.trim());
                    const ids = CATEGORY_DEFS
                        .filter(c => activeLabels.includes(c.api))
                        .map(c => c.id);
                    setSelectedCats(ids);
                }

                const restoredResults = Array.isArray(saved.results) ? saved.results : [];
                setResults(restoredResults);

                setLastSummary({
                    count: restoredResults.length,
                    minYear: restoredMinYear || null,
                    hasFilter: Boolean(jfRaw)
                });

                setHasSearched(true);
            } catch (err) {
                console.error("Failed to restore search", err);
            } finally {
                setRestoring(false);
            }
        }

        restore();
    }, []);



    useEffect(() => {
        getLastUpdated()
            .then(d => setLastUpdated(d.last_updated))
            .catch(() => setLastUpdated(null));
    }, []);

    function toggleCategory(id) {
        setSelectedCats(prev =>
            prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
        );
    }

    async function handleSearch() {
        if (!query.trim()) return;

        setHasSearched(true);
        setLoading(true);
        setErrorMsg("");
        try {
            const activeDefs = CATEGORY_DEFS.filter(c =>
                selectedCats.includes(c.id)
            );
            const journalFilter = activeDefs.map(c => c.api);

            const data = await searchPapers({
                query: query.trim(),
                minYear: minYear || null,
                journalFilter,
                journalName: journalName || null,
                titleKeyword: titleKeyword || null,
                authorKeyword: authorKeyword || null,
                maxK: maxK
            });


            setResults(data);
            setLastSummary({
                count: data.length,
                minYear: minYear || null,
                hasFilter: journalFilter.length > 0
            });
        } catch (err) {
            console.error(err);
            setErrorMsg("Search failed. Please try again.");
        } finally {
            setLoading(false);
        }
    }
    async function handleSave() {
        const payload = {
            query,
            max_k: maxK,
            min_year: minYear || null,
            journal_filter: selectedCats
                .map(id => CATEGORY_DEFS.find(c => c.id === id).api)
                .join(","),
            journal_name: journalName || null,
            title_keyword: titleKeyword || null,
            author_keyword: authorKeyword || null
        };

        try {
            const saved = await saveSearch(payload);
            setSavedHash(saved.hash);

            const url = `${window.location.origin}${window.location.pathname}?search=${saved.hash}`;
            navigator.clipboard.writeText(url).catch(() => {});
        } catch (err) {
            console.error(err);
        }
    }

    return (
        <div
            className={
                hasSearched
                    ? "flex flex-col md:flex-row h-full gap-3"
                    : "flex items-center justify-center h-full px-4"
            }
        >
            {/* LEFT COLUMN */}
            <div
                className={
                    hasSearched
                        ? "w-full md:w-[340px] flex flex-col items-center md:items-start"
                        : "w-full max-w-[700px] flex flex-col items-center"
                }
            >
                <a
                    href="https://www.eduard-bruell.de/"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <img
                        src="/logo.webp"
                        alt="Illustration of a meerkat holding a research paper"
                        className={
                            hasSearched
                                ? "w-full mb-1"
                                : "w-[360px] max-w-full mx-auto mb-2"
                        }
                    />
                </a>


                <SearchPanel
                    query={query}
                    setQuery={setQuery}
                    minYear={minYear}
                    setMinYear={setMinYear}
                    journalName={journalName}
                    setJournalName={setJournalName}
                    titleKeyword={titleKeyword}
                    setTitleKeyword={setTitleKeyword}
                    authorKeyword={authorKeyword}
                    setAuthorKeyword={setAuthorKeyword}
                    categories={CATEGORY_DEFS}
                    selectedCats={selectedCats}
                    onToggleCategory={toggleCategory}
                    onSearch={handleSearch}
                    hasSearched={hasSearched}
                    loading={loading}
                    maxK={maxK}
                    setMaxK={setMaxK}
                />

                {lastUpdated && (
                    <div className="mt-3 text-[11px] text-stone-500">
                        Database last updated on {lastUpdated}
                        <a
                            href="/faq"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 underline"
                        >
                            FAQ / Imprint
                        </a>
                    </div>
                )}


            </div>

            {/* RIGHT COLUMN – RESULTS */}
            <Results
                results={results}
                loading={loading}
                errorMsg={errorMsg}
                lastSummary={lastSummary}
                hasSearched={hasSearched}
                onSave={handleSave}
                savedHash={savedHash}
            />

        </div>
    );
}

