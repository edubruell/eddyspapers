import { z } from "zod";

// R emits explicit `current: null` / `total: null` on every emit_progress() call
// (jsonlite serializes the NULL defaults) — `.optional()` alone rejected those, silently
// dropping every R-side progress event. Accept null and coerce to undefined.
const rawProgressEventSchema = z.object({
  type: z.literal("progress"),
  label: z.string(),
  current: z.number().nullable().optional().transform((v) => v ?? undefined),
  total: z.number().nullable().optional().transform((v) => v ?? undefined),
});

// R emits explicit `null` (not absent) for missing fields — e.g. keyword/SQL
// papers carry `similarity: null`, and some articles have null authors/abstract.
// `.optional()` alone rejects null, which silently dropped whole papers (keyword
// sections rendered with no cards). Accept null and coerce to safe defaults so a
// paper is never discarded over a missing optional field.
const rawPaperEventSchema = z.object({
  type: z.literal("paper"),
  handle: z.string(),
  title: z.string().nullable().optional().transform((v) => v ?? ""),
  year: z.number().nullable().optional().transform((v) => v ?? 0),
  authors: z.string().nullable().optional().transform((v) => v ?? ""),
  journal: z.string().nullable().optional().transform((v) => v ?? ""),
  category: z.string().nullable().optional().transform((v) => v ?? ""),
  url: z.string(),
  similarity: z.number().nullable().optional(),
  abstract: z.string().nullable().optional(),
});

const SECTION_MODES = [
  "keyword",
  "semantic",
  "journal_scan",
  "author",
  "wp",
  "editor",
  "person",
  "custom",
] as const;

const rawSectionEventSchema = z.object({
  type: z.literal("section"),
  title: z.string(),
  handles: z.array(z.string()),
  note: z.string().nullable().optional(),
  // emit_section() stamps how the section was produced (semantic vs keyword, or an
  // explicit writer override). Absent on pre-mode scripts; unknown strings coerce to "custom".
  mode: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (SECTION_MODES.includes(v as (typeof SECTION_MODES)[number]) ? (v as (typeof SECTION_MODES)[number]) : undefined)),
});

const rawPersonEvidenceSchema = z.object({
  handle: z.string(),
  title: z.string().nullable().optional().transform((v) => v ?? ""),
  journal: z.string().nullable().optional().transform((v) => v ?? ""),
  year: z.number().nullable().optional().transform((v) => v ?? 0),
  score: z.number().nullable().optional().transform((v) => v ?? undefined),
});

// Person results carry the same null-tolerance as papers: only short_id and url are
// guaranteed, everything else (wikidata extras, stats) may arrive as explicit null.
const rawPersonEventSchema = z.object({
  type: z.literal("person"),
  short_id: z.string(),
  name: z.string().nullable().optional().transform((v) => v ?? ""),
  affiliation: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  wikipedia_url: z.string().nullable().optional(),
  orcid: z.string().nullable().optional(),
  url: z.string(),
  n_works: z.number().nullable().optional(),
  citations: z.number().nullable().optional(),
  first_year: z.number().nullable().optional(),
  last_year: z.number().nullable().optional(),
  primary_category: z.string().nullable().optional(),
  n_matched: z.number().nullable().optional(),
  // Wikidata extras — present for ~9% of people, explicit null/absent otherwise.
  birth_year: z.number().nullable().optional(),
  birth_place: z.string().nullable().optional(),
  citizenships: z.array(z.string()).nullable().optional(),
  educated_at: z.array(z.string()).nullable().optional(),
  doctoral_advisors: z.array(z.string()).nullable().optional(),
  doctoral_students: z.array(z.string()).nullable().optional(),
  memberships: z.array(z.string()).nullable().optional(),
  awards: z.array(z.string()).nullable().optional(),
  google_scholar_id: z.string().nullable().optional(),
  ssrn_author_id: z.string().nullable().optional(),
  math_genealogy_id: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  evidence: z.array(rawPersonEvidenceSchema).nullable().optional(),
});

const rawPersonSectionEventSchema = z.object({
  type: z.literal("person_section"),
  title: z.string(),
  short_ids: z.array(z.string()),
  note: z.string().nullable().optional(),
});

const rawBibtexEventSchema = z.object({
  type: z.literal("bibtex"),
  entries: z.number().optional(),
  bibtex: z.string().optional(),
  handles: z.array(z.string()).optional(),
});

const rawNoteEventSchema = z.object({
  type: z.literal("note"),
  markdown: z.string(),
});

const rawErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  recoverable: z.boolean(),
});

export const rawSandboxEventSchema = z.discriminatedUnion("type", [
  rawProgressEventSchema,
  rawPaperEventSchema,
  rawSectionEventSchema,
  rawPersonEventSchema,
  rawPersonSectionEventSchema,
  rawBibtexEventSchema,
  rawNoteEventSchema,
  rawErrorEventSchema,
]);

export type RawProgressEvent = z.infer<typeof rawProgressEventSchema>;
export type RawPaperEvent = z.infer<typeof rawPaperEventSchema>;
export type RawSectionEvent = z.infer<typeof rawSectionEventSchema>;
export type RawPersonEvent = z.infer<typeof rawPersonEventSchema>;
export type RawPersonSectionEvent = z.infer<typeof rawPersonSectionEventSchema>;
export type RawBibtexEvent = z.infer<typeof rawBibtexEventSchema>;
export type RawNoteEvent = z.infer<typeof rawNoteEventSchema>;
export type RawErrorEvent = z.infer<typeof rawErrorEventSchema>;
export type RawSandboxEvent = z.infer<typeof rawSandboxEventSchema>;

export type SeqEvent<T extends RawSandboxEvent = RawSandboxEvent> = T & {
  seq: number;
};

export function parseRawEvent(json: unknown): RawSandboxEvent | null {
  const result = rawSandboxEventSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function assignSeq(events: RawSandboxEvent[]): SeqEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

export function isProgressEvent(e: RawSandboxEvent): e is RawProgressEvent {
  return e.type === "progress";
}

export function isPaperEvent(e: RawSandboxEvent): e is RawPaperEvent {
  return e.type === "paper";
}

export function isSectionEvent(e: RawSandboxEvent): e is RawSectionEvent {
  return e.type === "section";
}

export function isPersonEvent(e: RawSandboxEvent): e is RawPersonEvent {
  return e.type === "person";
}

export function isPersonSectionEvent(e: RawSandboxEvent): e is RawPersonSectionEvent {
  return e.type === "person_section";
}

export function isBibtexEvent(e: RawSandboxEvent): e is RawBibtexEvent {
  return e.type === "bibtex";
}

export function isNoteEvent(e: RawSandboxEvent): e is RawNoteEvent {
  return e.type === "note";
}

export function isErrorEvent(e: RawSandboxEvent): e is RawErrorEvent {
  return e.type === "error";
}
