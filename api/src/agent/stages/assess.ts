import { generateStructured } from "../../llm/structured.js";
import { models, modelIds } from "../models.js";
import { assessorSystemMessage, assessorOutputSchema } from "../../prompts/assemble.js";
import type { Paper, Person, Section } from "../types.js";

export interface ResultFlags {
  all_empty: boolean;       // zero papers across all sections
  headline_empty: boolean;  // last section returned 0 rows while an earlier one did not
  thin: boolean;            // fewer than THIN_THRESHOLD distinct papers
  no_new: boolean;          // this round added no papers over prior rounds
}

// The refine pass is mandatory when enabled, so the assessor always returns advice for the next
// pass. `null` means the advisor call failed — the caller skips the refine and ships round 1.
export type AssessResult = { reason: string; directive: string; mode: "augment" | "replace" };

const THIN_THRESHOLD = 5;

// Deterministic pre-flags (07_multistage.md §3) — computed without an LLM and handed to the
// assessor as structured hints so it isn't guessing. `priorCount` is the distinct-paper count
// from earlier rounds (0 on round 1) used to derive `no_new`. In the shipped single-pass design
// assess only ever runs after round 1 (priorCount 0), so `no_new` is currently equivalent to
// `all_empty`; it is retained for the general multi-round design (07 §3) and unit coverage.
export function computeFlags(
  papers: Record<string, Paper>,
  sections: Section[],
  priorCount = 0,
  persons: Record<string, Person> = {},
): ResultFlags {
  // Persons count as results: a person-finder brief legitimately returns zero papers.
  const total = Object.keys(papers).length + Object.keys(persons).length;
  const nonEmptySections = sections.filter((s) => s.n_total > 0);
  const last = sections[sections.length - 1];
  return {
    all_empty: total === 0,
    headline_empty:
      sections.length > 1 && last != null && last.n_total === 0 && nonEmptySections.length > 0,
    thin: total > 0 && total < THIN_THRESHOLD,
    no_new: total <= priorCount,
  };
}

// Compact, cacheable result summary: section titles + counts and a tiny sample of rows.
// Never the full papers payload (§3).
export function summarizeResult(
  papers: Record<string, Paper>,
  sections: Section[],
  persons: Record<string, Person> = {},
): string {
  const sectionLines = sections.length
    ? sections
        .map((s) => `- "${s.title}": ${s.n_total} ${s.kind === "persons" ? "person(s)" : "paper(s)"}`)
        .join("\n")
    : "(no sections emitted)";

  const sample = Object.values(papers)
    .slice(0, 5)
    .map((p) => `- ${p.title} (${p.journal || "?"}, ${p.year || "?"})`)
    .join("\n");

  const personCount = Object.keys(persons).length;
  const personSample = Object.values(persons)
    .slice(0, 5)
    .map((p) => `- ${p.name} (${p.affiliation || "?"})`)
    .join("\n");
  const personBlock = personCount
    ? `\n\nDistinct persons: ${personCount}\n\nPerson sample:\n${personSample}`
    : "";

  return (
    `Sections:\n${sectionLines}\n\n` +
    `Distinct papers: ${Object.keys(papers).length}\n\n` +
    `Sample:\n${sample || "(none)"}` +
    personBlock
  );
}

export async function assess(opts: {
  brief: string;
  script: string;
  papers: Record<string, Paper>;
  sections: Section[];
  persons?: Record<string, Person>;
  priorCount?: number;
}): Promise<AssessResult | null> {
  const flags = computeFlags(opts.papers, opts.sections, opts.priorCount ?? 0, opts.persons ?? {});
  const summary = summarizeResult(opts.papers, opts.sections, opts.persons ?? {});

  const flagLine = (Object.entries(flags) as [keyof ResultFlags, boolean][])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  const userPrompt =
    `<brief>\n${opts.brief}\n</brief>\n\n` +
    `<flags>\n${flagLine}\n</flags>\n\n` +
    `<result_summary>\n${summary}\n</result_summary>`;

  let object: {
    assessment?: string;
    reason?: string;
    directive?: string;
    mode?: "augment" | "replace";
  };
  try {
    ({ object } = await generateStructured({
      model: models.assessor,
      modelId: modelIds.assessor,
      messages: [assessorSystemMessage, { role: "user", content: userPrompt }],
      schema: assessorOutputSchema,
      stage: "assess",
    }));
  } catch {
    // On advisor failure, skip the refine pass and ship round 1 rather than run a blind round 2.
    return null;
  }

  if (!object.directive) return null;
  return {
    reason: object.reason ?? "Refining the search strategy.",
    directive: object.directive,
    mode: object.mode ?? "augment",
  };
}
