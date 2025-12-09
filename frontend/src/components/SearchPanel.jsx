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
                                        onSearch,
                                        hasSearched,
                                    }) {
    return (
        <aside
            className={`flex flex-col gap-5 w-full
                bg-white/70 border border-stone-300 rounded-xl p-5
                md:sticky md:top-6`}
        >
            {/* QUERY FIELD */}
            <div>
                <label className="text-xs font-semibold text-stone-600 mb-1 block">
                    QUERY
                </label>

                <SearchBox
                    value={query}
                    onChange={(v) => setQuery(v)}
                    onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            onSearch();
                        }
                    }}
                />

                <div className="text-[10px] text-stone-500 mt-1">
                    Press ⌘+Enter or Ctrl+Enter to search.
                </div>
            </div>

            {/* CATEGORY PILLS */}
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

            {/* MIN YEAR */}
            <div>
                <label className="text-xs font-semibold text-stone-600 mb-1 block">
                    MINIMUM YEAR
                </label>
                <input
                    type="number"
                    value={minYear}
                    onChange={(e) => setMinYear(e.target.value)}
                    className="w-32 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                />
            </div>

            {/* SEARCH BUTTON */}
            <button
                onClick={onSearch}
                className="self-end px-4 py-2 bg-orange-400 text-white text-sm rounded-md hover:bg-orange-500"
            >
                Search
            </button>
        </aside>
    );
}
