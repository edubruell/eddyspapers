import { useState, useEffect } from "react";
import { searchPersons, loadPersonSearch } from "../lib/api.js";
import SearchPanel from "./SearchPanel.jsx";
import PersonResults from "./PersonResults.jsx";

function Logo({ compact = false }) {
  return (
    <img
      src="/logo_econpeople.png"
      alt="Econ People — Economist Search by Eduard Brüll"
      className={compact ? "h-auto w-full" : "h-auto w-full max-w-[340px]"}
    />
  );
}

export default function SearchApp() {
  const [query, setQuery] = useState("");
  const [scoringMode, setScoringMode] = useState("breadth");
  const [citationBoost, setCitationBoost] = useState(true);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const hasRun = results !== null;
  const qualityWeight = citationBoost ? 0.3 : 0;

  // Restore from shared link on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = params.get("s");
    if (!hash) return;

    loadPersonSearch(hash)
      .then((saved) => {
        if (!saved || saved.error) return;
        setQuery(saved.query ?? "");
        setScoringMode(saved.scoring_mode ?? "breadth");
        setCitationBoost((saved.quality_weight ?? 0.3) > 0);
        setResults({ results: saved.results ?? [], n_authors: (saved.results ?? []).length });
      })
      .catch(() => {});
  }, []);

  async function onSearch() {
    if (query.trim().length < 3) return;
    setLoading(true);
    setError(null);
    // Clear hash from URL when starting a new search
    const url = new URL(window.location.href);
    url.searchParams.delete("s");
    window.history.replaceState({}, "", url.toString());

    try {
      const data = await searchPersons({ query: query.trim(), scoringMode, qualityWeight });
      setResults(data);
    } catch (e) {
      setError(e.message);
      setResults({ results: [], n_authors: 0 });
    } finally {
      setLoading(false);
    }
  }

  function onNewSearch() {
    setResults(null);
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("s");
    window.history.replaceState({}, "", url.toString());
  }

  const panelProps = {
    query, setQuery,
    scoringMode, setScoringMode,
    citationBoost, setCitationBoost,
    onSearch, loading,
    frozen: false,
    lastUpdated,
  };

  // ── Landing state: centered logo + wide panel ──
  if (!hasRun) {
    return (
      <div className="flex flex-col items-center gap-6 pt-12 md:pt-20">
        <div className="w-full max-w-sm">
          <Logo />
        </div>
        <div className="w-full max-w-lg">
          <SearchPanel {...panelProps} compact={false} />
        </div>
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </div>
    );
  }

  // ── Results state: sidebar + results pane ──
  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      {/* Sidebar */}
      <div className="hidden md:flex flex-col gap-4 w-56 shrink-0 sticky top-6">
        <button
          type="button"
          onClick={onNewSearch}
          className="w-full"
        >
          <Logo compact />
        </button>
        <SearchPanel {...panelProps} compact />
        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}
      </div>

      {/* Mobile: compact top bar */}
      <div className="md:hidden w-full mb-4 space-y-3">
        <button type="button" onClick={onNewSearch} className="block w-32">
          <Logo compact />
        </button>
        <SearchPanel {...panelProps} compact />
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {/* Results */}
      <div className="flex-1 min-w-0">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-stone-400 text-sm">
            Searching…
          </div>
        ) : (
          <PersonResults
            data={results}
            query={query}
            scoringMode={scoringMode}
            qualityWeight={qualityWeight}
          />
        )}
      </div>
    </div>
  );
}
