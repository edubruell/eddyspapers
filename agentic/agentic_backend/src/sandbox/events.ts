import { z } from "zod";

const rawProgressEventSchema = z.object({
  type: z.literal("progress"),
  label: z.string(),
  current: z.number().optional(),
  total: z.number().optional(),
});

const rawPaperEventSchema = z.object({
  type: z.literal("paper"),
  handle: z.string(),
  title: z.string(),
  year: z.number(),
  authors: z.string(),
  journal: z.string(),
  category: z.string(),
  url: z.string(),
  similarity: z.number().optional(),
  abstract: z.string().nullable().optional(),
});

const rawSectionEventSchema = z.object({
  type: z.literal("section"),
  title: z.string(),
  handles: z.array(z.string()),
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
  rawBibtexEventSchema,
  rawNoteEventSchema,
  rawErrorEventSchema,
]);

export type RawProgressEvent = z.infer<typeof rawProgressEventSchema>;
export type RawPaperEvent = z.infer<typeof rawPaperEventSchema>;
export type RawSectionEvent = z.infer<typeof rawSectionEventSchema>;
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

export function isBibtexEvent(e: RawSandboxEvent): e is RawBibtexEvent {
  return e.type === "bibtex";
}

export function isNoteEvent(e: RawSandboxEvent): e is RawNoteEvent {
  return e.type === "note";
}

export function isErrorEvent(e: RawSandboxEvent): e is RawErrorEvent {
  return e.type === "error";
}
