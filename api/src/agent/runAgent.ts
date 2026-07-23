import type { StreamEvent, StreamEventPayload, Stage, AgentInput, Paper, Person, Section } from "./types.js";
import { clarify } from "./stages/clarify.js";
import { writeScript } from "./stages/writeScript.js";
import { executeScript } from "./stages/execute.js";
import { assess, summarizeResult } from "./stages/assess.js";
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

// At most one refine pass (07_multistage.md, single-refine-pass variant): round 1 + one revise.
// The cap is structural — the refine branch below runs exactly once and never loops.

// Merge two BibTeX bundles, deduping entries by cite-key so an augment pass that re-surfaces a
// round-1 paper does not emit its entry twice (the paper map already dedups by handle).
function mergeBibtex(a: string, b: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const chunk of `${a}\n${b}`.split(/(?=^@)/m)) {
    const entry = chunk.trim();
    if (!entry) continue;
    const key = entry.match(/^@\w+\s*\{\s*([^,]+),/)?.[1]?.trim() ?? entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join("\n");
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

  // One write → validate → execute round. Emits the stepper stage events and the live
  // strategy/paper/section/bibtex events. `revision`/`idOffset` drive the multistage refine pass.
  type RoundResult =
    | {
        ok: true;
        script: string;
        papers: Record<string, Paper>;
        persons: Record<string, Person>;
        sections: Section[];
        bibtex: string;
        partial?: boolean;
      }
    | { ok: false; message: string; recoverable: boolean };

  // Runs the stages and emits the stepper/result events, but does NOT terminate the run on
  // failure (no error/done) — the caller decides whether a failure is fatal (round 1, or a
  // replace round with nothing to fall back to) or recoverable (an augment round that can keep
  // the prior results).
  const runRound = async (
    dbDate: string,
    revision: NonNullable<Parameters<typeof writeScript>[0]["revision"]> | undefined,
    idOffset: number,
  ): Promise<RoundResult> => {
    let tStage = stageEnter("write");
    const writeResult = await writeScript({
      brief: input.brief,
      categories: input.categories,
      minYear: input.minYear,
      mustInclude: input.mustInclude,
      clarifyQuestion: input.clarifyQuestion,
      clarifyAnswer: input.clarifyAnswer,
      revision,
      dbDate,
    });

    if (!writeResult.ok) {
      stageExit("write", tStage);
      return {
        ok: false,
        recoverable: false,
        message:
          "rejected" in writeResult
            ? writeResult.reason
            : `Script generation failed after ${writeResult.attempts} attempts: ${writeResult.reason}`,
      };
    }

    // The user-facing signal is the plain-language strategy, not the R script.
    emit({ type: "strategy", strategy: writeResult.strategy });
    emit({ type: "script", delta: writeResult.script });
    stageExit("write", tStage);

    // Validate (writeScript already validated internally; surface for the stepper).
    tStage = stageEnter("validate");
    emit({ type: "validate", ok: true });
    stageExit("validate", tStage);

    // Execute.
    tStage = stageEnter("execute");
    const executeResult = await executeScript(writeResult.script, dbPath, (e) => emit(e), idOffset);
    if (!executeResult.ok) {
      stageExit("execute", tStage);
      return { ok: false, recoverable: false, message: `Execution failed: ${executeResult.message}` };
    }
    if (executeResult.partial) {
      emit({
        type: "progress",
        label: "The search timed out before finishing — continuing with the results found so far.",
      });
    }
    stageExit("execute", tStage);

    return {
      ok: true,
      script: writeResult.script,
      papers: executeResult.papers,
      persons: executeResult.persons ?? {},
      sections: executeResult.sections,
      bibtex: executeResult.bibtex,
      partial: executeResult.partial,
    };
  };

  try {
    const snapshot = await resolveSnapshot(dbPath);
    const dbDate =
      snapshot.exists && snapshot.ageMs != null
        ? new Date(Date.now() - snapshot.ageMs).toISOString().slice(0, 10)
        : "unknown";

    // ── Clarify ──────────────────────────────────────────────────────────────
    if (runClarify) {
      const tStage = stageEnter("clarify");
      const clarifyResult = await clarify(input.brief, dbDate);
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

    // ── Round 1 ────────────────────────────────────────────────────────────────
    const round1 = await runRound(dbDate, undefined, 0);
    if (!round1.ok) {
      fail(round1.message, round1.recoverable);
      return { paused: false };
    }

    let papers = round1.papers;
    let persons = round1.persons;
    let sections = round1.sections;
    let bibtex = round1.bibtex;
    let script = round1.script;
    let partial = round1.partial ?? false;

    // ── Refine pass (07_multistage.md) — opt-in but MANDATORY when enabled ──────
    // The advisor always proposes one more pass; only an advisor failure (null) skips it.
    if (input.refine) {
      const advice = await assess({ brief: input.brief, script, papers, sections, persons });
      if (advice) {
        emit({ type: "revise", reason: advice.reason, mode: advice.mode });

        const round2 = await runRound(
          dbDate,
          {
            previousScript: script,
            resultSummary: summarizeResult(papers, sections, persons),
            directive: advice.directive,
            mode: advice.mode,
          },
          sections.length, // keep round-2 section ids unique
        );

        if (!round2.ok) {
          // augment keeps round-1 intact, so a failed refine pass degrades to the round-1
          // review with a caveat rather than throwing the good result away. replace had already
          // discarded round 1 (on the client too), so there is nothing safe to fall back to.
          if (
            advice.mode === "replace" ||
            (Object.keys(papers).length === 0 && Object.keys(persons).length === 0)
          ) {
            fail(round2.message, round2.recoverable);
            return { paused: false };
          }
          emit({ type: "progress", label: "The refine pass didn't return more — showing the first set." });
        } else if (advice.mode === "replace") {
          // Discard round 1: the prior approach was wrong and was re-derived this round.
          papers = round2.papers;
          persons = round2.persons;
          sections = round2.sections;
          bibtex = round2.bibtex;
          script = round2.script;
          partial = round2.partial ?? false;
        } else {
          // augment: union by handle; append new sections; dedup the merged BibTeX by cite-key.
          papers = { ...papers, ...round2.papers };
          persons = { ...persons, ...round2.persons };
          sections = [...sections, ...round2.sections];
          bibtex = mergeBibtex(bibtex, round2.bibtex);
          script = round2.script;
          partial = partial || (round2.partial ?? false);
          // Re-emit the consolidated bundle so the artifact reflects the accumulated set.
          emit({ type: "bibtex", entries: Object.keys(papers).length, bibtex });
        }
      }
    }

    // ── Synthesize (once, over the accumulated set) ─────────────────────────────
    const tStage = stageEnter("synthesize");
    let synthesis = "";
    if (Object.keys(papers).length === 0 && Object.keys(persons).length === 0) {
      emit({ type: "synthesis", delta: "_No results were returned by the search script._" });
      synthesis = "_No results were returned by the search script._";
    } else {
      synthesis = await synthesize(
        input.brief,
        script,
        sections,
        papers,
        persons,
        bibtex,
        dbDate,
        (delta) => emit({ type: "synthesis", delta }),
      );
      if (partial) {
        const caveat =
          "\n\n---\n*This search was cut short by a timeout before every planned query finished — " +
          "the review above is based on a partial result set and coverage may be incomplete.*";
        emit({ type: "synthesis", delta: caveat });
        synthesis += caveat;
      }
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
