import { useEffect, useState } from "react";
import {
    getVersions,
    getCites,
    getCitedBy,
    getCitationCounts
} from "../lib/api";

export default function HandleDetail({ handle }) {
    const [versions, setVersions] = useState(null);
    const [cites, setCites] = useState(null);
    const [citedBy, setCitedBy] = useState(null);
    const [counts, setCounts] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;

        async function load() {
            try {
                const [v, ci, cb, ct] = await Promise.all([
                    getVersions(handle),
                    getCites(handle),
                    getCitedBy(handle),
                    getCitationCounts(handle)
                ]);

                if (!active) return;

                setVersions(v || []);
                setCites(ci || []);
                setCitedBy(cb || []);
                setCounts(ct || null);
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

    return (
        <div className="mt-3 border-t border-stone-200 pt-3 text-xs space-y-4">
            {/* Citation counts */}
            {counts && (
                <div className="text-stone-700">
                    Cited by {counts.total_citations} papers ({counts.internal_citations} in database)
                </div>
            )}

            {/* Versions */}
            {versions && versions.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800">
                        Other versions
                    </div>
                    <ul className="space-y-1">
                        {versions.map((v) => (
                            <li key={v.target}>
    <span className="text-stone-700">
        {v.year ? `${v.year}. ` : ""}
    </span>

                                <span className="text-stone-700">
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
                                    <span className="text-stone-600">
            {` ${v.journal}.`}
        </span>
                                )}
                            </li>

                        ))}
                    </ul>
                </div>
            )}

            {/* Cited-by (papers citing this one) */}
            {citedBy && citedBy.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800">
                        Cited by these papers in the database:
                    </div>
                    <ul className="space-y-2">
                        {citedBy.map((p) => (
                            <li key={p.handle}>
                                <span className="text-stone-700">
                                    {p.year ? `${p.year}. ` : ""}
                                </span>
                                <span className="text-stone-700">
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
                                    <span className="text-stone-600">
                                        {` ${p.journal}.`}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* References (papers this one cites) */}
            {cites && cites.length > 0 && (
                <div>
                    <div className="font-semibold mb-1 text-stone-800">
                        References in the database:
                    </div>
                    <ul className="space-y-2">
                        {cites.map((p) => (
                            <li key={p.handle}>
                                <span className="text-stone-700">
                                    {p.year ? `${p.year}. ` : ""}
                                </span>
                                <span className="text-stone-700">
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
                                    <span className="text-stone-600">
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
