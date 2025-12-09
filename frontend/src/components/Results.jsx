import ResultCard from "./ResultCard.jsx";

export default function Results({ results, loading, errorMsg, lastSummary, hasSearched }) {
    if (!hasSearched) return null;

    return (
        <section className="flex-1 px-3 py-3 flex flex-col gap-2 overflow-y-auto h-full">
            <header className="flex items-baseline justify-between gap-2">
                <div>
                    <h2 className="text-sm font-semibold tracking-wide text-stone-700 uppercase">
                        Results
                    </h2>
                    {lastSummary && (
                        <p className="text-xs text-stone-500">
                            Showing {lastSummary.count} papers
                            {lastSummary.minYear ? ` from ${lastSummary.minYear} onward` : ""}
                            {lastSummary.hasFilter ? " with journal filters" : " across all journals"}.
                        </p>
                    )}
                </div>
            </header>

            {loading && (
                <div className="flex items-center gap-2 text-sm text-stone-600">
                    <div className="h-4 w-4 border-2 border-stone-400 border-t-transparent rounded-full animate-spin"></div>
                    <span>Searching for papers …</span>
                </div>
            )}

            {errorMsg && (
                <p className="text-sm text-red-600" role="alert">
                    {errorMsg}
                </p>
            )}

            {!loading && !errorMsg && results.length === 0 && (
                <p className="text-sm text-stone-500"></p>
            )}

            <div className="space-y-2 pr-1">
                {results.map((paper) => (
                    <ResultCard key={paper.Handle} paper={paper} />
                ))}
            </div>
        </section>
    );
}
