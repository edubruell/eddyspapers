import { useState } from "react";

function categoryClasses(category) {
    if (!category) {
        return "border-l-stone-300 bg-stone-50";
    }
    if (category.includes("Top 5")) {
        return "border-l-amber-400 bg-amber-50";
    }
    if (category.includes("Top Field")) {
        return "border-l-amber-300 bg-amber-50";
    }
    if (category.includes("AEJ")) {
        return "border-l-orange-300 bg-orange-50";
    }
    if (category.includes("Second in Field")) {
        return "border-l-stone-300 bg-stone-50";
    }
    if (category.includes("Working Paper")) {
        return "border-l-emerald-300 bg-emerald-50";
    }
    if (category.includes("General Interest")) {
        return "border-l-sky-400 bg-sky-50";
    }
    return "border-l-stone-200 bg-stone-50";
}

export default function ResultCard({ paper }) {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);

    async function copyBibtex() {
        try {
            await navigator.clipboard.writeText(paper.bib_tex || "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (err) {
            console.error("Clipboard error", err);
        }
    }

    const catCls = categoryClasses(paper.category);

    return (
        <article
            className={`relative rounded-lg border border-stone-200 shadow-sm px-3 pb-2 pt-2  flex flex-col gap-1 border-l-4 ${catCls}`}
        >
            <header className="flex items-start justify-between gap-2">
                <div>
                    <h3 className="font-semibold text-sm md:text-base text-stone-900">
                        <a href={paper.url} target="_blank" rel="noreferrer"
                           className="hover:underline text-stone-900">
                            {paper.title}
                        </a>
                    </h3>
                    <p className="text-xs md:text-sm text-stone-700">
                        {paper.authors}
                    </p>
                    <p className="text-xs italic text-stone-600">
                        {paper.journal}{" "}
                        {paper.year ? `(${paper.year})` : null}
                    </p>
                </div>
                <div className="text-right text-[11px] text-stone-500 whitespace-nowrap">
                    <div>Similarity</div>
                    <div className="font-semibold text-stone-700">
                        {paper.similarity_score?.toFixed
                            ? paper.similarity_score.toFixed(3)
                            : paper.similarity_score}
                    </div>
                </div>
            </header>

            {paper.abstract && (
                <div
                    className={`mt-1 text-[12px] text-stone-700 leading-snug ${
                        expanded ? "" : "max-h-24 overflow-hidden"
                    }`}
                >
                    {paper.abstract}
                </div>
            )}

            <footer className="mt-2 flex justify-end">
                <div className="ml-auto inline-flex items-center gap-2">
                    <button
                        type="button"
                        onClick={copyBibtex}
                        title={copied ? "BibTeX copied to clipboard" : "Copy BibTeX"}
                        aria-label={copied ? "BibTeX copied to clipboard" : "Copy BibTeX"}
                        className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-[11px] md:text-xs text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-orange-200"
                    >
                        {copied ? (
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                                <path fillRule="evenodd" d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.5 7.6a1 1 0 0 1-1.436 0l-3.5-3.543a1 1 0 1 1 1.424-1.404l2.782 2.816 6.784-6.88a1 1 0 0 1 1.44-.003Z" clipRule="evenodd" />
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5">
                                <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round"/>
                                <rect x="4" y="3" width="14" height="18" rx="2" ry="2"/>
                                <rect x="8" y="7" width="12" height="14" rx="2" ry="2" opacity=".15"/>
                            </svg>
                        )}
                        <span>{copied ? "Copied" : "BibTeX"}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        title={expanded ? "Show less" : "Show more"}
                        aria-label={expanded ? "Show less" : "Show more"}
                        className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-[11px] md:text-xs text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-orange-200"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                            {expanded ? (
                                // minus icon
                                <path fillRule="evenodd" d="M4 10a1 1 0 0 1 1-1h10a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Z" clipRule="evenodd" />
                            ) : (
                                // ellipsis horizontal icon
                                <path d="M6.5 10a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0Zm6 0a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0Zm4.5 1.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3Z" />
                            )}
                        </svg>
                        <span>{expanded ? "Less" : "More"}</span>
                    </button>
                </div>
            </footer>
        </article>
    );
}
