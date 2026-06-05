import type { StreamEvent, StreamEventPayload, Stage, AgentInput, Paper, Section } from "./types.js";
import { clarify } from "./stages/clarify.js";
import { writeScript } from "./stages/writeScript.js";
import { executeScript } from "./stages/execute.js";
import { synthesize } from "./stages/synthesize.js";
import { resolveSnapshot } from "../sandbox/snapshot.js";

export async function runAgent(
  searchId: string,
  input: AgentInput,
  dbPath: string,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  let seq = 0;
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
    let tStage = stageEnter("clarify");
    const clarifyResult = await clarify(input.brief);
    if (clarifyResult.action === "reject") {
      stageExit("clarify", tStage);
      fail(clarifyResult.reason);
      return;
    }
    if (clarifyResult.action === "question") {
      emit({ type: "assistant", stage: "clarify", delta: clarifyResult.question });
    }
    stageExit("clarify", tStage);

    // ── Write ─────────────────────────────────────────────────────────────────
    tStage = stageEnter("write");
    const snapshot = await resolveSnapshot(dbPath);
    const writeResult = await writeScript({
      brief: input.brief,
      categories: input.categories,
      minYear: input.minYear,
      mustInclude: input.mustInclude,
      dbDate: snapshot.exists && snapshot.ageMs != null ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10) : "unknown",
    });

    if (!writeResult.ok) {
      stageExit("write", tStage);
      fail(
        "rejected" in writeResult
          ? writeResult.reason
          : `Script generation failed after ${writeResult.attempts} attempts: ${writeResult.reason}`,
      );
      return;
    }

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
      return;
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
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Unexpected error in ${currentStage}: ${message}`);
  }
}
