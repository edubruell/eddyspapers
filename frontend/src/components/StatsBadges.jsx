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

export default function StatsBadges({ stats }) {
    if (!stats) return null;

    const citationYears = stats?.citations_by_year?.years || null;
    const citationCounts = stats?.citations_by_year?.counts || null;

    // IDEAS-style coverage rule
    const hasCoverage =
        stats.internal_citations != null ||
        (citationCounts && citationCounts.length > 0) ||
        stats.total_references != null;

    if (!hasCoverage) return null;

    return (
        <div className="flex flex-wrap items-center gap-2">
            <StatBadge icon={CitIcon} label="Citations" value={stats.total_citations} />
            <StatBadge icon={CitIcon} label="Citations (in Database)" value={stats.internal_citations} />
            <StatBadge icon={CitIcon} label="References" value={stats.total_references} />

            <StatBadge
                icon={UpArrowIcon}
                label="Top Percentile"
                value={
                    stats.citation_percentile != null
                        ? (stats.citation_percentile * 100).toFixed(0)
                        : null
                }
            />

            <StatBadge
                icon={CentralityIcon}
                label="Med. Cited-by Percentile"
                value={
                    stats.median_citer_percentile != null
                        ? (stats.median_citer_percentile * 100).toFixed(0)
                        : null
                }
            />

            {citationYears && citationCounts && (
                <div className="ml-auto flex items-center">
                    <MiniHistogram years={citationYears} counts={citationCounts} />
                </div>
            )}
        </div>
    );
}
