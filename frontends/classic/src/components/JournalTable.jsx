import { useEffect, useState } from "react";
import { getJournalStats } from "../lib/api";

export default function JournalTable() {
    const [journals, setJournals] = useState(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        getJournalStats()
            .then(data => {
                const sorted = data
                    .filter(j => j.journal)
                    .sort((a, b) => a.journal.localeCompare(b.journal));
                setJournals(sorted);
            })
            .catch(err => {
                console.error(err);
                setError(true);
            });
    }, []);

    if (error) {
        return (
            <p className="text-sm text-red-600">
                Failed to load journal statistics.
            </p>
        );
    }

    if (!journals) {
        return (
            <p className="text-sm text-gray-500">
                Loading…
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse bg-white text-sm">
                <thead>
                <tr className="bg-gray-100">
                    <th className="px-3 py-2 text-left font-medium text-gray-700">
                        Journal or Series
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">
                        Items
                    </th>
                </tr>
                </thead>
                <tbody>
                {journals.map(j => (
                    <tr
                        key={j.journal}
                        className="border-b last:border-b-0 hover:bg-gray-50"
                    >
                        <td className="px-3 py-2 text-gray-900">
                            {j.journal}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-700 tabular-nums">
                            {j.n}
                        </td>
                    </tr>
                ))}
                </tbody>
            </table>
        </div>
    );
}
