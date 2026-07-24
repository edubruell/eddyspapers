import { Hono } from "hono";
import { z } from "zod";
import { getCorpusDb, getAppDataDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import { semanticSearch } from "../search/papers.js";
import type { SemanticParams, SemanticResult } from "../search/types.js";
import {
  saveSearch,
  getSavedSearch,
  logSearch,
  searchHash,
  type SavedSearchParams,
} from "../db/classic.js";
import { clientIp } from "../util/clientIp.js";

// Classic semantic-search routes ported from the retired Plumber api.R (PLAN.md §A2).
// Wire fields are snake_case; the response of POST /search is a *bare array* (no envelope),
// exactly as the classic frontend's searchPapers() expects.

const csv = (v: string | null | undefined): string[] | null => {
  if (!v) return null;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
};

const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

// Recompute similarity_score = round(1 - similarity, 5) and sort desc — mirrors both the
// /search response processing and the /search/<hash> re-derivation in Plumber.
const finalize = (results: SemanticResult[]): SemanticResult[] =>
  results
    .map((r) => ({ ...r, similarity_score: round5(1 - r.similarity) }))
    .sort((a, b) => b.similarity_score - a.similarity_score);

const searchBodySchema = z.object({
  query: z.string().min(1),
  max_k: z.number().int().positive().max(1000).optional(),
  min_year: z.number().int().nullish(),
  journal_filter: z.string().nullish(),
  journal_name: z.string().nullish(),
  title_keyword: z.string().nullish(),
  author_keyword: z.string().nullish(),
  // JEL codes or prefixes, comma-separable ("J31" or "J3,C21").
  jel: z
    .string()
    .regex(/^\s*[A-Za-z]\d{0,2}(\s*,\s*[A-Za-z]\d{0,2})*\s*$/, "jel must be comma-separated JEL codes")
    .nullish(),
});

type SearchBody = z.infer<typeof searchBodySchema>;

const parseBody = async (c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const savedParamsOf = (b: SearchBody): SavedSearchParams => ({
  query: b.query,
  maxK: b.max_k ?? 100,
  minYear: b.min_year ?? null,
  journalFilter: b.journal_filter ?? null,
  journalName: b.journal_name ?? null,
  titleKeyword: b.title_keyword ?? null,
  authorKeyword: b.author_keyword ?? null,
});

const semanticParamsOf = (b: SearchBody): SemanticParams => ({
  query: b.query,
  maxK: b.max_k ?? 100,
  minYear: b.min_year ?? null,
  journalFilter: csv(b.journal_filter),
  journalName: csv(b.journal_name),
  titleKeyword: b.title_keyword ?? null,
  authorKeyword: b.author_keyword ?? null,
  jel: csv(b.jel),
});

const flagsOf = (b: SearchBody) => ({
  hasYear: b.min_year != null,
  hasJournalFilter: !!(b.journal_filter && b.journal_filter.length > 0),
  hasJournalName: !!(b.journal_name && b.journal_name.length > 0),
  hasTitleKeyword: !!(b.title_keyword && b.title_keyword.length > 0),
  hasAuthorKeyword: !!(b.author_keyword && b.author_keyword.length > 0),
});

// Log a completed search; failures are swallowed (Plumber wrapped log_search in tryCatch —
// a logging problem must never fail the search itself).
const logQuietly = async (
  ip: string,
  queryHash: string,
  results: SemanticResult[],
  b: SearchBody,
  startedAt: number,
): Promise<void> => {
  try {
    const appdata = await getAppDataDb();
    await logSearch(appdata, {
      ip,
      queryHash,
      resultCount: results.length,
      top3Handles: results.slice(0, 3).map((r) => r.Handle),
      flags: flagsOf(b),
      responseTimeMs: Math.round(performance.now() - startedAt),
    });
  } catch {
    /* logging is best-effort */
  }
};

export const searchRoute = new Hono();

searchRoute.post("/", requireKey("rest"), async (c) => {
  const started = performance.now();
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const db = await getCorpusDb();
  const results = finalize(await semanticSearch(db, semanticParamsOf(parsed.data)));

  await logQuietly(clientIp(c), searchHash(savedParamsOf(parsed.data)), results, parsed.data, started);
  return c.json(results);
});

searchRoute.post("/save", requireKey("rest"), async (c) => {
  const started = performance.now();
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = searchBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  // Saved searches hash the seven classic params; silently dropping a jel
  // filter on reload would misrepresent the saved result set, so reject until
  // the hash/appdata schema learns the field.
  if (parsed.data.jel) {
    return c.json({ error: "jel filter is not yet supported for saved searches" }, 400);
  }

  const db = await getCorpusDb();
  const results = finalize(await semanticSearch(db, semanticParamsOf(parsed.data)));

  const appdata = await getAppDataDb();
  const hash = await saveSearch(appdata, savedParamsOf(parsed.data), results);

  await logQuietly(clientIp(c), hash, results, parsed.data, started);
  return c.json({ hash, results });
});

searchRoute.get("/:hash", requireKey("rest"), async (c) => {
  const appdata = await getAppDataDb();
  const saved = await getSavedSearch(appdata, c.req.param("hash"));
  // Plumber mirrors a "not found" as HTTP 200 + { error, status: 404 } (it sets res$status
  // on a plain list). Preserve that byte-for-byte — loadSavedSearch() in the frontend does
  // not branch on the HTTP status.
  if (!saved) return c.json({ error: "Search not found", status: 404 });

  return c.json({
    hash: saved.hash,
    query: saved.query,
    max_k: saved.maxK,
    min_year: saved.minYear,
    journal_filter: saved.journalFilter,
    journal_name: saved.journalName,
    title_keyword: saved.titleKeyword,
    author_keyword: saved.authorKeyword,
    created_at: saved.createdAt,
    results: finalize(saved.results),
  });
});
