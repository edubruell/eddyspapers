import { Hono } from "hono";
import { z } from "zod";
import { getCorpusDb } from "../db/singleton.js";
import { requireAuth } from "../middleware/auth.js";
import { keywordSearch, verifyReferences } from "../search/papers.js";

// Keyword + reference-verification endpoints (PLAN.md §B1/§B2) — the first
// Hono-native search surface. Wire fields are snake_case to match the existing
// Plumber conventions the frontends and skills already speak.

const keywordBodySchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  fields: z.array(z.enum(["title", "abstract", "authors"])).min(1).optional(),
  match: z.enum(["any", "all"]).optional(),
  min_year: z.number().int().nullish(),
  max_year: z.number().int().nullish(),
  categories: z.array(z.string()).nullish(),
  journal_name: z.union([z.string().min(1), z.array(z.string().min(1))]).nullish(),
  order_by: z.enum(["year", "citations"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

const verifyBodySchema = z.object({
  entries: z
    .array(
      z.object({
        cite_key: z.string().nullish(),
        handle: z.string().nullish(),
        author_lastnames: z.string().nullish(),
        year: z.number().int().nullish(),
        title: z.string().nullish(),
        journal: z.string().nullish(),
      }),
    )
    .min(1)
    .max(200),
});

const parseBody = async (c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

export const papersRoute = new Hono();

// Both routes sit behind the shared gate like the other POST surface; Phase 4
// replaces this with scoped API keys (PLAN.md §D1).
papersRoute.post("/keyword", requireAuth, async (c) => {
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = keywordBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const p = parsed.data;
  const db = await getCorpusDb();
  const result = await keywordSearch(db, {
    keywords: p.keywords,
    fields: p.fields,
    match: p.match,
    minYear: p.min_year,
    maxYear: p.max_year,
    categories: p.categories,
    journalName:
      p.journal_name == null
        ? null
        : Array.isArray(p.journal_name)
          ? p.journal_name
          : p.journal_name.split(",").map((s) => s.trim()).filter(Boolean),
    orderBy: p.order_by,
    limit: p.limit,
    offset: p.offset,
  });
  return c.json(result);
});

papersRoute.post("/verify", requireAuth, async (c) => {
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = verifyBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const db = await getCorpusDb();
  const results = await verifyReferences(db, parsed.data.entries);
  return c.json({ results });
});
