export type Stage = "clarify" | "write" | "validate" | "execute" | "synthesize";

export interface SectionRow {
  handle: string;
  rank: number;
  similarity?: number;
}

export interface Section {
  id: string;
  title: string;
  mode: "keyword" | "semantic" | "journal_scan" | "author" | "wp" | "editor" | "person" | "custom";
  // "papers" (default) — rows reference Paper handles; "persons" — rows reference
  // Person short_ids via the same `handle` field.
  kind?: "papers" | "persons";
  query?: string;
  sql?: string;
  filters?: {
    min_year?: number;
    journals?: string[];
    categories?: string[];
    journal_name?: string;
  };
  n_total: number;
  n_shown: number;
  rows: SectionRow[];
  note?: string;
}

export interface PaperStats {
  cites_total?: number;
  cites_internal?: number;
  percentile?: number;
  top5_citer_share?: number;
  cites_by_year?: { year: number; n: number }[];
}

export interface Paper {
  handle: string;
  title: string;
  authors: string[];
  year: number;
  journal: string;
  category: string;
  url: string;
  abstract: string | null;
  bibtex: string;
  stats?: PaperStats;
  versions?: string[];
}

export interface PersonEvidence {
  handle: string;
  title: string;
  journal: string;
  year: number;
  score?: number;
}

export interface Person {
  short_id: string;
  name: string;
  affiliation: string | null;
  homepage: string | null;
  image_url: string | null;
  wikipedia_url: string | null;
  orcid: string | null;
  url: string;
  n_works: number | null;
  citations: number | null;
  first_year: number | null;
  last_year: number | null;
  primary_category: string | null;
  n_matched: number | null;
  evidence: PersonEvidence[];
}

export type StreamEvent =
  | { type: "stage"; seq: number; stage: Stage; state: "enter" | "exit"; ms?: number }
  | { type: "assistant"; seq: number; stage: Stage; delta: string }
  | { type: "clarify"; seq: number; question: string; options: string[]; required: boolean }
  | { type: "strategy"; seq: number; strategy: string }
  | { type: "revise"; seq: number; reason: string; mode: "augment" | "replace" }
  | { type: "script"; seq: number; delta: string }
  | { type: "validate"; seq: number; ok: boolean; reason?: string; offending?: string }
  | { type: "progress"; seq: number; label: string; current?: number; total?: number }
  | { type: "section"; seq: number; section: Section }
  | { type: "paper"; seq: number; paper: Paper }
  | { type: "person"; seq: number; person: Person }
  | { type: "bibtex"; seq: number; entries: number; bibtex: string }
  | { type: "synthesis"; seq: number; delta: string }
  | { type: "error"; seq: number; where: Stage; message: string; recoverable: boolean }
  | { type: "done"; seq: number; ms_total: number };

export interface AgentInput {
  brief: string;
  categories?: string[];
  minYear?: number;
  mustInclude?: string[];
  // When true the clarify stage never blocks/asks (MCP default, web opt-in via the
  // "one-shot" checkbox). A `question` result is treated as `proceed`.
  skipClarify?: boolean;
  // When true the agent may run ONE results-aware refine pass (07_multistage.md): after
  // round 1 executes, an assessor decides adequate vs revise; on revise a single corrected
  // write→validate→execute round runs before synthesis. Off by default — zero added cost.
  refine?: boolean;
  // Set on the resume (Phase B) pass: the question that was asked and the user's
  // answer, folded into the writer's user message as a <clarification> block.
  clarifyQuestion?: string;
  clarifyAnswer?: string;
}

// Distributive Omit — preserves the discriminated union when removing a shared key
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StreamEventPayload = DistributiveOmit<StreamEvent, "seq">;
