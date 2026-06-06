import { STAGES } from "../../lib/store.js";

const LABELS = {
  clarify: "clarify",
  write: "write",
  validate: "validate",
  execute: "execute",
  synthesize: "synthesize",
};

function Dot({ status }) {
  const base = "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]";
  if (status === "done") {
    return (
      <span
        className={base + " border-transparent text-white"}
        style={{ background: "var(--sim-hi)" }}
      >
        ✓
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        className={base + " border-transparent"}
        style={{ background: "var(--primary)" }}
      >
        <span className="agentic-spin h-2 w-2 rounded-full border border-white border-t-transparent" />
      </span>
    );
  }
  if (status === "waiting") {
    // Paused, awaiting the user's clarifier reply — steady (not spinning) purple ring.
    return (
      <span
        className={base + " text-white"}
        style={{ background: "var(--accent-purple)", borderColor: "transparent" }}
        title="Waiting for your answer"
      >
        ?
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        className={base + " border-transparent text-white"}
        style={{ background: "var(--sim-lo)" }}
      >
        !
      </span>
    );
  }
  return <span className={base + " border-stone-300 text-stone-400"} />;
}

export default function StageStepper({ stages }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {STAGES.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <Dot status={stages[s]} />
          <span
            className={
              "text-xs " +
              (stages[s] === "active"
                ? "font-semibold text-stone-800"
                : stages[s] === "waiting"
                  ? "font-semibold text-[var(--accent-purple)]"
                  : stages[s] === "done"
                    ? "text-stone-600"
                    : "text-stone-400")
            }
          >
            {LABELS[s]}
          </span>
          {i < STAGES.length - 1 && <span className="text-stone-300">·</span>}
        </div>
      ))}
    </div>
  );
}
