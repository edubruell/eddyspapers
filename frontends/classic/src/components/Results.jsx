import { useState } from "react";
import ResultCard from "./ResultCard.jsx";

export default function Results({
                                    results,
                                    loading,
                                    errorMsg,
                                    lastSummary,
                                    hasSearched,
                                    onSave,
                                    savedHash,
                                    onExportBibtex,
                                    onExportExcel
                                }) {
    const [exportOpen, setExportOpen] = useState(false);

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
                            Showing {lastSummary.count} results
                            {lastSummary.minYear ? ` from ${lastSummary.minYear} onward` : ""}.
                        </p>
                    )}
                </div>

                <div className="relative inline-flex gap-1">
                    {/* Export */}
                    <button
                        type="button"
                        onClick={() => setExportOpen(v => !v)}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 border border-stone-300 rounded
                                   text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-orange-200"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                             stroke="currentColor" className="size-6">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="m9 12.75 3 3m0 0 3-3m-3 3v-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
                        </svg>

                        <span>Export</span>
                    </button>

                    {exportOpen && (
                        <div
                            className="absolute right-0 top-full mt-1 w-36 rounded border border-stone-200 bg-white shadow-md z-10"
                        >
                            <button
                                type="button"
                                className="block w-full text-left px-3 py-2 text-[11px] text-stone-700 hover:bg-stone-100"
                                onClick={() => {
                                    setExportOpen(false);
                                    onExportBibtex();
                                }}
                            >
                                BibTeX (.bib)
                            </button>
                            <button
                                type="button"
                                className="block w-full text-left px-3 py-2 text-[11px] text-stone-700 hover:bg-stone-100"
                                onClick={() => {
                                    setExportOpen(false);
                                    onExportExcel();
                                }}
                            >
                                Excel (.xlsx)
                            </button>
                        </div>
                    )}

                    {/* Share */}
                    <button
                        type="button"
                        onClick={onSave}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 border border-stone-300 rounded
                                   text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-orange-200"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                             stroke="currentColor" className="size-6">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                  d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/>
                        </svg>

                        <span>Share</span>
                    </button>
                </div>
            </header>

            {savedHash && (
                <div className="text-[11px] text-stone-500 mt-1">
                    Link copied. Anyone can reopen this search with:
                    <span className="block text-stone-700 mt-1 break-all">
                        {`${window.location.origin}${window.location.pathname}?search=${savedHash}`}
                    </span>
                </div>
            )}

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
