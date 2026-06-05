import { useState } from "react";
import { startChat } from "../../lib/api.js";
import { useAgentStream } from "../../lib/stream.js";
import { CATEGORY_DEFS, DEFAULT_CATEGORY_IDS } from "../../lib/categories.js";
import LogoAgentic from "../logo/LogoAgentic.jsx";
import { SectionLabel } from "../primitives/index.jsx";
import Sidebar from "./Sidebar.jsx";
import StageStepper from "./StageStepper.jsx";
import ProgressLine from "./ProgressLine.jsx";
import StrategyPanel from "./StrategyPanel.jsx";
import ClarifierBubble from "./ClarifierBubble.jsx";
import SynthesisPanel from "./SynthesisPanel.jsx";
import SectionCard from "./SectionCard.jsx";
import ArtifactsToolbar from "./ArtifactsToolbar.jsx";

export default function SearchChat() {
  const [brief, setBrief] = useState("");
  const [selected, setSelected] = useState(DEFAULT_CATEGORY_IDS);
  const [id, setId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState(null);

  const state = useAgentStream(id);
  const hasRun = id != null;
  const frozen = hasRun && !state.done && !state.error;

  function toggleCategory(cid) {
    setSelected((prev) =>
      prev.includes(cid) ? prev.filter((c) => c !== cid) : [...prev, cid],
    );
  }

  async function onRun() {
    if (brief.trim().length < 15) {
      setStartError("Please describe what you're looking for (at least a sentence).");
      return;
    }
    setSubmitting(true);
    setStartError(null);
    try {
      const categories = CATEGORY_DEFS.filter((c) => selected.includes(c.id)).map(
        (c) => c.api,
      );
      const { id: newId } = await startChat({
        brief: brief.trim(),
        categories,
      });
      setId(newId);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function onNewSearch() {
    setId(null);
    setStartError(null);
  }

  const sidebar = (
    <Sidebar
      brief={brief}
      setBrief={setBrief}
      selected={selected}
      toggleCategory={toggleCategory}
      onRun={onRun}
      submitting={submitting}
      frozen={frozen}
      compact={hasRun}
    />
  );

  // ── Landing state ──────────────────────────────────────────────────────────
  if (!hasRun) {
    return (
      <div className="mx-auto flex max-w-[680px] flex-col items-center gap-6 pt-6">
        <LogoAgentic />
        <div className="w-full rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-5 shadow-sm">
          {sidebar}
          {startError && (
            <p className="mt-3 text-sm text-red-600">{startError}</p>
          )}
        </div>
      </div>
    );
  }

  // ── Working / results state ─────────────────────────────────────────────────
  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4 md:flex-row">
      {/* sidebar */}
      <aside className="w-full md:w-[320px] md:shrink-0">
        <div className="mb-3 flex items-center justify-between">
          <LogoAgentic compact />
          <button
            type="button"
            onClick={onNewSearch}
            className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
          >
            New search
          </button>
        </div>
        <div className="rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-4 shadow-sm">
          {sidebar}
          {startError && <p className="mt-3 text-sm text-red-600">{startError}</p>}
        </div>
      </aside>

      {/* right pane */}
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <StageStepper stages={state.stages} />
          <ProgressLine
            progress={state.progress}
            done={state.done}
            msTotal={state.msTotal}
          />
        </div>

        <StrategyPanel strategy={state.strategy} pending={state.strategyPending} />

        <ClarifierBubble question={state.clarifierQuestion} />

        {state.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error.message ||
              "Couldn't finish — here's what I have so far."}
          </div>
        )}

        <SynthesisPanel synthesis={state.synthesis} />

        <ArtifactsToolbar bibtex={state.bibtex} synthesis={state.synthesis} />

        {state.sections.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionLabel className="pt-2">Evidence</SectionLabel>
            {state.sections.map((section) => (
              <SectionCard
                key={section.id}
                section={section}
                papers={state.papers}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
