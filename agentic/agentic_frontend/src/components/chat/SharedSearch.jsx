import { useEffect, useState } from "react";
import { getSharedSearch } from "../../lib/api.js";
import { replayEvents } from "../../lib/replay.js";
import LogoAgentic from "../logo/LogoAgentic.jsx";
import { SectionLabel } from "../primitives/index.jsx";
import StrategyPanel from "./StrategyPanel.jsx";
import SynthesisPanel from "./SynthesisPanel.jsx";
import SectionCard from "./SectionCard.jsx";
import ArtifactsToolbar from "./ArtifactsToolbar.jsx";

function readId() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("s");
}

// Read-only permalink view of a stored run (08_sharelinks.md). Not behind the password gate:
// it fetches the persisted events and replays them through the same reducer the live UI uses.
export default function SharedSearch() {
  const [phase, setPhase] = useState("loading"); // loading | missing | error | ready
  const [brief, setBrief] = useState("");
  const [state, setState] = useState(null);

  useEffect(() => {
    const id = readId();
    if (!id) {
      setPhase("missing");
      return;
    }
    const controller = new AbortController();
    getSharedSearch(id, { signal: controller.signal })
      .then((data) => {
        if (!data) {
          setPhase("missing");
          return;
        }
        setBrief(data.brief ?? "");
        setState(replayEvents(data.events));
        setPhase("ready");
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setPhase("error");
      });
    return () => controller.abort();
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-stone-500">
        Loading shared search…
      </div>
    );
  }

  if (phase === "missing" || phase === "error") {
    return (
      <div className="mx-auto flex max-w-[680px] flex-col items-center gap-6 pt-16 text-center">
        <LogoAgentic />
        <div className="w-full rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-6 shadow-sm">
          <p className="text-sm text-stone-700">
            {phase === "missing"
              ? "This shared search couldn't be found — the link may be incomplete or the run has expired."
              : "Something went wrong loading this shared search."}
          </p>
          <a href="/" className="mt-4 inline-block text-sm font-medium text-[var(--primary)] hover:underline">
            Run your own search →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4 md:flex-row">
      <aside className="w-full md:w-[320px] md:shrink-0">
        <div className="mb-3">
          <LogoAgentic compact />
        </div>
        <div className="rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-4 shadow-sm">
          <SectionLabel>Shared search</SectionLabel>
          <p className="mt-2 whitespace-pre-wrap text-sm text-stone-800">{brief}</p>
          <a
            href="/"
            className="mt-4 inline-block text-sm font-medium text-[var(--primary)] hover:underline"
          >
            Run your own search →
          </a>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <StrategyPanel strategy={state.strategy} pending={false} />

        <SynthesisPanel synthesis={state.synthesis} />

        <ArtifactsToolbar
          bibtex={state.bibtex}
          synthesis={state.synthesis}
          papers={state.papers}
          serverExports={false}
        />

        {state.sections.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionLabel className="pt-2">Evidence</SectionLabel>
            {state.sections.map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                papers={state.papers}
                persons={state.persons}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
