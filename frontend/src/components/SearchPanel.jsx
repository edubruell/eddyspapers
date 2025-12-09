import { useState } from "react";
import SearchBox from "./SearchBox.jsx";
import CategoryPills from "./CategoryPills.jsx";

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
                                        onSearch
                                    }) {
    const [showAdvanced, setShowAdvanced] = useState(false);

    return (
        <aside
            className="flex flex-col gap-5 w-full
                 bg-white/70 border border-stone-300 rounded-xl p-5
                 md:sticky md:top-6"
        >
            {/* Query */}
            <div>
                <label className="text-xs font-semibold text-stone-600 mb-1 block">
                    QUERY
                </label>

                <SearchBox
                    value={query}
                    onChange={(v) => setQuery(v)}
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
                onClick={() => setShowAdvanced(x => !x)}
                className="text-xs text-stone-600 rounded-md border border-r-2 border-b-2
             border-stone-600 flex items-center gap-2 pl-3 pr-2 py-1"
            >
  <span className="text-[20px] leading-none">
    {showAdvanced ? "▼" : "►"}
  </span>
                {showAdvanced ? "Hide advanced filters" : "Show advanced filters"}
            </button>


            {/* Advanced section */}
            {showAdvanced && (
                <div className="flex flex-col gap-4 border-t border-stone-300 pt-4">

                    {/* Minimum Year */}
                    <div>
                        <label className="text-xs font-semibold text-stone-600 mb-1 block">
                            MINIMUM YEAR
                        </label>
                        <input
                            type="number"
                            min={1995}
                            max={new Date().getFullYear()}
                            value={minYear}
                            onChange={(e) => setMinYear(e.target.value)}
                            className="w-32 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                        />
                    </div>

                    {/* Journal name filter */}
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

                    {/* Title keyword filter */}
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

                    {/* Author keyword filter */}
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

                </div>
            )}

            {/* Search */}
            <button
                onClick={onSearch}
                className="self-end px-4 py-2 bg-sky-800 text-white text-sm rounded-md hover:bg-sky-500"
            >
                Search
            </button>
        </aside>
    );
}
