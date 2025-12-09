import { useState } from "react";
import { searchPapers } from "../lib/api";
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
    { id: "wp", label: "Working Paper Series", api: "Working Paper Series" }
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
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [lastSummary, setLastSummary] = useState(null);
    const [hasSearched, setHasSearched] = useState(false);

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
                maxK: 100
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
                <img
                    src="/logo.webp"
                    alt="Eddy's Papers Logo"
                    className={
                        hasSearched
                            ? "w-full mb-1"
                            : "w-[360px] max-w-full mx-auto mb-2"
                    }
                />

                <SearchPanel
                    query={query}
                    setQuery={setQuery}
                    minYear={minYear}
                    setMinYear={setMinYear}
                    categories={CATEGORY_DEFS}
                    selectedCats={selectedCats}
                    onToggleCategory={toggleCategory}
                    onSearch={handleSearch}
                    hasSearched={hasSearched}
                    loading={loading}
                />
            </div>

            {/* RIGHT COLUMN – RESULTS */}
            <Results
                results={results}
                loading={loading}
                errorMsg={errorMsg}
                lastSummary={lastSummary}
                hasSearched={hasSearched}
            />
        </div>
    );
}

