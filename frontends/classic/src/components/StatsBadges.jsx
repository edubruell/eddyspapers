// StatsBadges.jsx
import React from "react";

export function StatBadge({ icon, label, value }) {
    if (value == null) return null;

    return (
        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-stone-300 bg-stone-100 text-[11px] md:text-xs text-stone-700">
            {icon}
            <span className="font-semibold">{value}</span>
            <span className="opacity-70">{label}</span>
        </div>
    );
}

// A badge that is itself a link (OpenAlex record, open-access full text).
export function LinkBadge({ icon, label, href }) {
    if (!href) return null;

    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-sky-300 bg-sky-50 text-[11px] md:text-xs text-sky-800 hover:bg-sky-100"
        >
            {icon}
            <span className="font-semibold">{label}</span>
        </a>
    );
}

export const OpenAlexIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.2" />
    </svg>
);

export const CitIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <path d="M5 5h10M5 10h10M5 15h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
);

export const RefIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <rect x="5" y="4" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 7h5M7.5 10h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
);

export const UpArrowIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3l6 7h-4v7h-4v-7H4l6-7z" />
    </svg>
);

export const CentralityIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="3" fill="currentColor" />
        <path
            d="M10 2v3M10 15v3M2 10h3M15 10h3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
        />
    </svg>
);

export function MiniHistogram({ years, counts }) {
    if (!years || !counts || counts.length === 0) return null;

    const max = Math.max(...counts);
    if (max === 0) return null;

    return (
        <div className="flex flex-col">
            <div className="text-[10px] text-stone-500 mb-1">
                Citations by year
            </div>

            <div className="flex items-end gap-1 h-10 text-[10px] text-stone-600">
                {counts.map((c, i) => {
                    const height = (c / max) * 32;

                    return (
                        <div
                            key={i}
                            className="bg-stone-800 rounded-sm"
                            style={{
                                width: "6px",
                                height: `${height}px`,
                                opacity: 0.9
                            }}
                            title={`${years[i]}: ${c} citations`}
                        />
                    );
                })}
                <div className="ml-2">
                    {years[0]}–{years[years.length - 1]}
                </div>
            </div>
        </div>
    );
}

export default function StatsBadges({ stats, openalex }) {
    const citationYears = stats?.citations_by_year?.years || null;
    const citationCounts = stats?.citations_by_year?.counts || null;

    // IDEAS-style coverage rule, now also satisfied by OpenAlex data — a paper can carry
    // whole-literature OpenAlex metrics even when it has no RePEc-internal citation stats.
    const hasRepecCoverage =
        !!stats &&
        (stats.internal_citations != null ||
            (citationCounts && citationCounts.length > 0) ||
            stats.total_references != null);

    const hasOpenAlex =
        !!openalex && (openalex.oa_cited_by_count != null || openalex.openalex_id);

    if (!hasRepecCoverage && !hasOpenAlex) return null;

    return (
        <div className="flex flex-wrap items-center gap-2">
            {/* RePEc citation graph (curated corpus subset) */}
            <StatBadge icon={CitIcon} label="RePEc cites" value={stats?.total_citations} />
            <StatBadge icon={CitIcon} label="RePEc cites (in DB)" value={stats?.internal_citations} />
            <StatBadge icon={RefIcon} label="References" value={stats?.total_references} />

            {/* OpenAlex — whole-literature citation count + link to the record */}
            {openalex && (
                <StatBadge
                    icon={OpenAlexIcon}
                    label="OpenAlex Cites"
                    value={openalex.oa_cited_by_count}
                />
            )}
            {openalex?.fwci != null && (
                <StatBadge icon={UpArrowIcon} label="FWCI" value={openalex.fwci.toFixed(2)} />
            )}
            {openalex?.is_top10 && (
                <StatBadge icon={UpArrowIcon} label="Top 10% (field)" value={"★"} />
            )}
            {openalex?.is_retracted && (
                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-red-400 bg-red-50 text-[11px] md:text-xs font-semibold text-red-700">
                    ⚠ Retracted
                </div>
            )}

            <StatBadge
                icon={UpArrowIcon}
                label="Top Percentile"
                value={
                    stats?.citation_percentile != null
                        ? (stats.citation_percentile * 100).toFixed(0)
                        : null
                }
            />

            <StatBadge
                icon={CentralityIcon}
                label="Med. Cited-by Percentile"
                value={
                    stats?.median_citer_percentile != null
                        ? (stats.median_citer_percentile * 100).toFixed(0)
                        : null
                }
            />

            <LinkBadge icon={OpenAlexIcon} label="OpenAlex" href={openalex?.openalex_id} />
            {openalex?.is_oa && (
                <LinkBadge icon={RefIcon} label="Open Access" href={openalex?.oa_url} />
            )}

            {citationYears && citationCounts && (
                <div className="ml-auto flex items-center">
                    <MiniHistogram years={citationYears} counts={citationCounts} />
                </div>
            )}
        </div>
    );
}
