import { useState } from "react";
import SearchBox from "./SearchBox.jsx";
import CategoryPills from "./CategoryPills.jsx";
import JelPicker from "./JelPicker.jsx";

export default function SearchPanel({
                                        query,
                                        setQuery,
                                        categories,
                                        selectedCats,
                                        onToggleCategory,
                                        minYear,
                                        setMinYear,
                                        journalName,
                                        setJournalName,
                                        titleKeyword,
                                        setTitleKeyword,
                                        authorKeyword,
                                        setAuthorKeyword,
                                        jel,
                                        setJel,
                                        maxK,
                                        setMaxK,
                                        onSearch,
                                        lastUpdated,
                                        hasSearched
                                    }) {
    const [showAdvanced, setShowAdvanced] = useState(false);

    return (
        <aside
            className="
        flex flex-col w-full
        bg-white/70 border border-stone-300 rounded-xl p-5
        md:sticky md:top-6
        md:max-h-[calc(100vh-3rem)]
        md:overflow-hidden
      "
        >
            {/* Scrollable content */}
            <div className="flex flex-col gap-5 overflow-y-auto pr-1">

                {/* Query */}
                <div>
                    <label className="text-xs font-semibold text-stone-600 mb-1 block">
                        QUERY
                    </label>

                    <SearchBox
                        value={query}
                        onChange={setQuery}
                        rows={hasSearched ? 3 : 4}
                        onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSearch();
                        }}
                    />

                    <div className="text-[10px] text-stone-500 mt-1">
                        Press ⌘+Enter or Ctrl+Enter to search.
                    </div>
                </div>

                {/* Categories */}
                <div>
                    <label className="text-xs font-semibold text-stone-600 mb-1 block">
                        JOURNAL CATEGORIES
                    </label>

                    <CategoryPills
                        categories={categories}
                        selectedCats={selectedCats}
                        onToggleCategory={onToggleCategory}
                    />
                </div>

                {/* Toggle advanced filters */}
                <button
                    type="button"
                    onClick={() => setShowAdvanced(v => !v)}
                    aria-expanded={showAdvanced}
                    className="
            self-start flex items-center gap-1.5 py-1
            text-xs font-semibold text-stone-600 hover:text-stone-800
          "
                >
                    <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
                    >
                        <path d="M6 4l4 4-4 4" />
                    </svg>
                    {showAdvanced ? "Hide advanced filters" : "Show advanced filters"}
                </button>

                {/* Advanced section */}
                {showAdvanced && (
                    <div className="flex flex-col gap-3 border-t border-stone-300 pt-3">

                        {/* Year + maxK row */}
                        <div className="flex flex-wrap gap-4 items-end">
                            <div>
                                <label className="text-xs font-semibold text-stone-600 mb-1 block">
                                    MIN YEAR
                                </label>
                                <input
                                    type="number"
                                    min={1995}
                                    max={new Date().getFullYear()}
                                    value={minYear || 1995}
                                    onChange={(e) => setMinYear(e.target.value)}
                                    className="w-28 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                                />
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-stone-600 mb-1 block">
                                    MAX RESULTS
                                </label>
                                <input
                                    type="number"
                                    min={1}
                                    max={500}
                                    value={maxK}
                                    onChange={(e) => setMaxK(Number(e.target.value))}
                                    className="w-28 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                                />
                            </div>
                        </div>

                        {/* Journal name */}
                        <div>
                            <label className="text-xs font-semibold text-stone-600 mb-1 block">
                                JOURNAL NAME CONTAINS
                            </label>
                            <input
                                type="text"
                                value={journalName}
                                onChange={(e) => setJournalName(e.target.value)}
                                className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                            />
                        </div>

                        {/* Title keyword */}
                        <div>
                            <label className="text-xs font-semibold text-stone-600 mb-1 block">
                                TITLE CONTAINS
                            </label>
                            <input
                                type="text"
                                value={titleKeyword}
                                onChange={(e) => setTitleKeyword(e.target.value)}
                                className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                            />
                        </div>

                        {/* Author keyword */}
                        <div>
                            <label className="text-xs font-semibold text-stone-600 mb-1 block">
                                AUTHOR NAME CONTAINS
                            </label>
                            <input
                                type="text"
                                value={authorKeyword}
                                onChange={(e) => setAuthorKeyword(e.target.value)}
                                className="w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                            />
                        </div>

                        {/* JEL codes */}
                        <JelPicker value={jel} onChange={setJel} />

                    </div>
                )}

            </div>

            {/* Fixed action row */}
            <div className="pt-3 mt-3 border-t border-stone-300 flex flex-col gap-2">
                <div className="flex justify-end">
                    <button
                        onClick={onSearch}
                        className="px-4 py-2 bg-sky-800 text-white text-sm rounded-md hover:bg-sky-500"
                    >
                        Search
                    </button>
                </div>

                {lastUpdated && (
                    <div className="text-center text-[11px] text-stone-500">
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

        </aside>
    );
}
