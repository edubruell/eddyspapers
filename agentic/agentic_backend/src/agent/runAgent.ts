import type { StreamEvent, StreamEventPayload, Stage, AgentInput, Paper, Section } from "./types.js";
import { clarify } from "./stages/clarify.js";
import { writeScript } from "./stages/writeScript.js";
import { executeScript } from "./stages/execute.js";
import { synthesize } from "./stages/synthesize.js";
import { resolveSnapshot } from "../sandbox/snapshot.js";

export interface RunResult {
  // True when the clarifier asked a question and the run suspended awaiting a reply.
  // No `done` event is emitted in this case — the caller persists `awaiting_clarification`
  // and resumes via runAgent(..., { startSeq, runClarify: false }) once the answer arrives.
  paused: boolean;
}

export interface RunOpts {
  // Seq to start numbering from. Phase B (resume) continues where Phase A left off so the
  // SSE replay-by-seq contract holds across the pause.
  startSeq?: number;
  // When false the clarify stage is skipped entirely (the resume pass — it already ran).
  runClarify?: boolean;
}

export async function runAgent(
  searchId: string,
  input: AgentInput,
  dbPath: string,
  onEvent: (e: StreamEvent) => void,
  opts: RunOpts = {},
): Promise<RunResult> {
  const runClarify = opts.runClarify ?? true;
  let seq = opts.startSeq ?? 0;
  const t0 = Date.now();
  let currentStage: Stage = "clarify";

  const emit = (e: StreamEventPayload): void => {
    onEvent({ ...e, seq: seq++ } as StreamEvent);
  };

  const stageEnter = (stage: Stage): number => {
    currentStage = stage;
    emit({ type: "stage", stage, state: "enter" });
    return Date.now();
  };

  const stageExit = (stage: Stage, t: number): void => {
    emit({ type: "stage", stage, state: "exit", ms: Date.now() - t });
  };

  const fail = (message: string, recoverable = false): void => {
    emit({ type: "error", where: currentStage, message, recoverable });
    emit({ type: "done", ms_total: Date.now() - t0 });
  };

  try {
    // ── Clarify ──────────────────────────────────────────────────────────────
    if (runClarify) {
      const tStage = stageEnter("clarify");
      const clarifyResult = await clarify(input.brief);
      if (clarifyResult.action === "reject") {
        stageExit("clarify", tStage);
        fail(clarifyResult.reason);
        return { paused: false };
      }
      // Block-and-ask only when the user did NOT opt for one-shot. With skipClarify the
      // clarify call still rejects gibberish above, but a `question` is treated as proceed.
      if (clarifyResult.action === "question" && !input.skipClarify) {
        emit({
          type: "clarify",
          question: clarifyResult.question,
          options: clarifyResult.options,
          required: true,
        });
        // Suspend: leave the clarify stage in the "waiting" state (no stage-exit, no done).
        return { paused: true };
      }
      stageExit("clarify", tStage);
    } else {
      // Resume pass: the clarify stage was left active on pause — close it out as done.
      currentStage = "clarify";
      emit({ type: "stage", stage: "clarify", state: "exit" });
    }

    // ── Write ─────────────────────────────────────────────────────────────────
    let tStage = stageEnter("write");
    const snapshot = await resolveSnapshot(dbPath);
    const writeResult = await writeScript({
      brief: input.brief,
      categories: input.categories,
      minYear: input.minYear,
      mustInclude: input.mustInclude,
      clarifyQuestion: input.clarifyQuestion,
      clarifyAnswer: input.clarifyAnswer,
      dbDate: snapshot.exists && snapshot.ageMs != null ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10) : "unknown",
    });

    if (!writeResult.ok) {
      stageExit("write", tStage);
      fail(
        "rejected" in writeResult
          ? writeResult.reason
          : `Script generation failed after ${writeResult.attempts} attempts: ${writeResult.reason}`,
      );
      return { paused: false };
    }

    // The user-facing signal is the plain-language strategy, not the R script.
    // The script event is still emitted (debug / fixtures) but the frontend does not render it.
    emit({ type: "strategy", strategy: writeResult.strategy });
    emit({ type: "script", delta: writeResult.script });
    stageExit("write", tStage);

    // ── Validate ──────────────────────────────────────────────────────────────
    // writeScript already ran validation internally; surface the outcome for the stepper
    tStage = stageEnter("validate");
    emit({ type: "validate", ok: true });
    stageExit("validate", tStage);

    // ── Execute ───────────────────────────────────────────────────────────────
    tStage = stageEnter("execute");
    let papers: Record<string, Paper> = {};
    let sections: Section[] = [];
    let bibtex = "";

    const executeResult = await executeScript(
      writeResult.script,
      dbPath,
      (e) => emit(e),
    );

    if (!executeResult.ok) {
      stageExit("execute", tStage);
      fail(`Execution failed: ${executeResult.message}`, false);
      return { paused: false };
    }

    papers = executeResult.papers;
    sections = executeResult.sections;
    bibtex = executeResult.bibtex;
    stageExit("execute", tStage);

    // ── Synthesize ────────────────────────────────────────────────────────────
    tStage = stageEnter("synthesize");
    let synthesis = "";
    if (Object.keys(papers).length === 0) {
      emit({ type: "synthesis", delta: "_No papers were returned by the search script._" });
      synthesis = "_No papers were returned by the search script._";
    } else {
      synthesis = await synthesize(
        input.brief,
        writeResult.script,
        sections,
        papers,
        bibtex,
        (delta) => emit({ type: "synthesis", delta }),
      );
    }
    stageExit("synthesize", tStage);

    emit({ type: "done", ms_total: Date.now() - t0 });
    return { paused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Unexpected error in ${currentStage}: ${message}`);
    return { paused: false };
  }
}
