// Reducer over the StreamEvent taxonomy (agentic_backend/src/agent/types.ts).
// The `script` event is intentionally ignored — the user is shown the plain-language
// `strategy` instead of the R script (decided 2026-06-05, 03_interface.md §3.2).

export const STAGES = ["clarify", "write", "validate", "execute", "synthesize"];

export function initialState() {
  return {
    started: false,
    stages: Object.fromEntries(STAGES.map((s) => [s, "pending"])),
    stageMs: {},
    progress: null,
    strategy: null,
    strategyPending: false,
    clarifierQuestion: null,
    papers: {},
    sections: [],
    synthesis: "",
    bibtex: null,
    error: null,
    done: false,
    msTotal: null,
  };
}

export function reduceEvent(state, e) {
  switch (e.type) {
    case "stage": {
      const stages = { ...state.stages };
      const stageMs = { ...state.stageMs };
      if (e.state === "enter") {
        stages[e.stage] = "active";
        const patch = { ...state, started: true, stages };
        if (e.stage === "write") patch.strategyPending = true;
        return patch;
      }
      // exit
      if (stages[e.stage] !== "failed") stages[e.stage] = "done";
      if (typeof e.ms === "number") stageMs[e.stage] = e.ms;
      return { ...state, stages, stageMs };
    }

    case "assistant":
      // clarifier question (single optional turn)
      return {
        ...state,
        clarifierQuestion: (state.clarifierQuestion ?? "") + e.delta,
      };

    case "strategy":
      return { ...state, strategy: e.strategy, strategyPending: false };

    case "script":
      return state; // never surfaced

    case "validate":
      if (!e.ok) {
        const stages = { ...state.stages, validate: "failed" };
        return { ...state, stages };
      }
      return state;

    case "progress":
      return {
        ...state,
        progress: { label: e.label, current: e.current, total: e.total },
      };

    case "section": {
      const sections = state.sections.filter((s) => s.id !== e.section.id);
      sections.push(e.section);
      return { ...state, sections };
    }

    case "paper":
      return {
        ...state,
        papers: { ...state.papers, [e.paper.handle]: e.paper },
      };

    case "bibtex":
      return { ...state, bibtex: { entries: e.entries, bibtex: e.bibtex } };

    case "synthesis":
      return { ...state, synthesis: state.synthesis + e.delta };

    case "error": {
      const stages = { ...state.stages };
      if (e.where && stages[e.where] !== undefined) stages[e.where] = "failed";
      return {
        ...state,
        stages,
        error: { where: e.where, message: e.message, recoverable: e.recoverable },
      };
    }

    case "done": {
      // The run is finished — any stage still showing active/pending (e.g. a
      // stage-exit event that didn't arrive) is resolved to done. Failed stays.
      const stages = Object.fromEntries(
        Object.entries(state.stages).map(([k, v]) => [k, v === "failed" ? v : "done"]),
      );
      return { ...state, stages, done: true, msTotal: e.ms_total };
    }

    default:
      return state;
  }
}
