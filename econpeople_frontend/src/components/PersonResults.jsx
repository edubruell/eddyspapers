import PersonCard from "./PersonCard.jsx";
import ShareButton from "./ShareButton.jsx";

export default function PersonResults({ data, query, scoringMode, qualityWeight }) {
  const results = data?.results ?? [];

  return (
    <div className="space-y-3">
      {/* Results header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-stone-500">
          {data?.n_authors ?? results.length} economist{results.length !== 1 ? "s" : ""} found
        </span>
        {results.length > 0 && (
          <ShareButton
            query={query}
            scoringMode={scoringMode}
            qualityWeight={qualityWeight}
            results={results}
          />
        )}
      </div>

      {/* Cards */}
      {results.map((person) => (
        <PersonCard key={person.short_id} person={person} />
      ))}

      {results.length === 0 && (
        <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-card)] p-8 text-center text-sm text-stone-400">
          No economists matched this query. Try a broader topic or fewer filters.
        </div>
      )}
    </div>
  );
}
