export type Stage = "clarify" | "write" | "validate" | "execute" | "synthesize";

export interface SectionRow {
  handle: string;
  rank: number;
  similarity?: number;
}

export interface Section {
  id: string;
  title: string;
  mode: "keyword" | "semantic" | "journal_scan" | "author" | "wp" | "editor" | "custom";
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

export type StreamEvent =
  | { type: "stage"; seq: number; stage: Stage; state: "enter" | "exit"; ms?: number }
  | { type: "assistant"; seq: number; stage: Stage; delta: string }
  | { type: "script"; seq: number; delta: string }
  | { type: "validate"; seq: number; ok: boolean; reason?: string; offending?: string }
  | { type: "progress"; seq: number; label: string; current?: number; total?: number }
  | { type: "section"; seq: number; section: Section }
  | { type: "paper"; seq: number; paper: Paper }
  | { type: "bibtex"; seq: number; entries: number; bibtex: string }
  | { type: "synthesis"; seq: number; delta: string }
  | { type: "error"; seq: number; where: Stage; message: string; recoverable: boolean }
  | { type: "done"; seq: number; ms_total: number };

export interface AgentInput {
  brief: string;
  categories?: string[];
  minYear?: number;
  mustInclude?: string[];
}

// Distributive Omit — preserves the discriminated union when removing a shared key
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StreamEventPayload = DistributiveOmit<StreamEvent, "seq">;
