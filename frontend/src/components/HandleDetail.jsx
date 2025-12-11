import { useEffect, useState } from "react";
import {
    getVersions,
    getCites,
    getCitedBy,
    getHandleStats
} from "../lib/api";

function StatBadge({ icon, label, value }) {
    if (value == null) return null;

    return (
        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-stone-300 bg-stone-100 text-[11px] md:text-xs text-stone-700">
            {icon}
            <span className="font-semibold">{value}</span>
            <span className="opacity-70">{label}</span>
        </div>
    );
}

const CitIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <path d="M5 5h10M5 10h10M5 15h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
);

const RefIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <rect x="5" y="4" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 7h5M7.5 10h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
);

const UpArrowIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3l6 7h-4v7h-4v-7H4l6-7z" />
    </svg>
);

const CentralityIcon = (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="3" fill="currentColor" />
        <path d="M10 2v3M10 15v3M2 10h3M15 10h3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round" />
    </svg>
);


function MiniHistogram({ years, counts }) {
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



export default function HandleDetail({ handle }) {
    const [versions, setVersions] = useState(null);
    const [cites, setCites] = useState(null);
    const [citedBy, setCitedBy] = useState(null);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;
        setLoading(true);

        async function load() {
            try {
                const [v, ci, cb, st] = await Promise.all([
                    getVersions(handle),
                    getCites(handle),
                    getCitedBy(handle),
                    getHandleStats(handle)
                ]);

                if (!active) return;

                setVersions(v || []);
                setCites(ci || []);
                setCitedBy(cb || []);
                setStats(st || null);
                setLoading(false);
            } catch (err) {
                console.error("Detail fetch failed", err);
                if (active) setLoading(false);
            }
        }

        load();
        return () => {
            active = false;
        };
    }, [handle]);

    if (loading) {
        return (
            <div className="mt-3 text-xs text-stone-500">
                Loading details
            </div>
        );
    }

    const citationYears = stats?.citations_by_year?.years || null;
    const citationCounts = stats?.citations_by_year?.counts || null;

    return (
        <div className="mt-3 border-t border-stone-200 pt-3 text-xs space-y-4">
            {stats && (
                <div className="flex flex-wrap items-center gap-2">
                    <StatBadge
                        icon={CitIcon}
                        label="Citations"
                        value={stats.total_citations}
                    />
                    <StatBadge
                        icon={CitIcon}
                        label="Citations (in Database)"
                        value={stats.internal_citations}
                    />
                    <StatBadge
                        icon={CitIcon}
                        label="References"
                        value={stats.total_references}
                    />
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
            )}

            {versions && versions.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800 text-[16px]">
                        Other versions:
                    </div>
                    <ul className="space-y-1">
                        {versions.map((v) => (
                            <li key={v.target}>
                                <span className="text-stone-700 font-semibold">
                                    {v.year ? `${v.year} - ` : ""}
                                </span>
                                <span className="text-stone-700 font-semibold">
                                    {v.authors ? `${v.authors}. ` : ""}
                                </span>
                                <a
                                    href={v.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-stone-900 hover:underline"
                                >
                                    {v.title}
                                </a>
                                {v.journal && (
                                    <span className="text-stone-600 italic">
                                        {` ${v.journal}.`}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {citedBy && citedBy.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800 text-[16px]">
                        Cited by these papers in the database:
                    </div>
                    <ul className="space-y-2">
                        {citedBy.map((p) => (
                            <li key={p.handle}>
                                <span className="text-stone-700 font-semibold">
                                    {p.year ? `${p.year} - ` : ""}
                                </span>
                                <span className="text-stone-700 font-semibold">
                                    {p.authors ? `${p.authors} ` : ""}
                                </span>
                                <a
                                    href={p.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-stone-900 hover:underline"
                                >
                                    {p.title}
                                </a>
                                {p.journal && (
                                    <span className="text-stone-600 italic">
                                        {` ${p.journal}.`}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {cites && cites.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800 text-[16px]">
                        References in the database:
                    </div>
                    <ul className="space-y-2">
                        {cites.map((p) => (
                            <li key={p.handle}>
                                <span className="text-stone-700 font-semibold">
                                    {p.year ? `${p.year} - ` : ""}
                                </span>
                                <span className="text-stone-700 font-semibold">
                                    {p.authors ? `${p.authors}. ` : ""}
                                </span>
                                <a
                                    href={p.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-stone-900 hover:underline"
                                >
                                    {p.title}
                                </a>
                                {p.journal && (
                                    <span className="text-stone-600 italic">
                                        {` ${p.journal}.`}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
