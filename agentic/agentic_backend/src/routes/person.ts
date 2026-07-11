import { Hono } from "hono";
import { z } from "zod";
import { getCorpusDb, getAppDataDb } from "../db/singleton.js";
import { requireKey } from "../middleware/requireKey.js";
import { personSearch } from "../search/persons.js";
import { lookupPersonsByName, personProfile, personPapers } from "../search/personProfile.js";
import type { PersonResult } from "../search/types.js";
import {
  savePersonSearch,
  getSavedPersonSearch,
  logPersonSearch,
  getPersonSearchStats,
  personSearchLogsDay,
} from "../db/classic.js";
import { canonicalHash8 } from "../search/hash.js";
import { clientIp } from "../util/clientIp.js";

// EconPeople /person/* routes ported from Plumber (PLAN.md §A2). Register static/specific
// paths BEFORE /:short_id so "lookup", "stats", "dailylogs", "search" never fall into the
// profile param route.

export const personRoute = new Hono();

const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

const csv = (v: string | null | undefined): string[] | null => {
  if (!v) return null;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
};

const parseBody = async (c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const personSearchSchema = z.object({
  query: z.string().min(1),
  k_papers: z.number().int().positive().max(5000).optional(),
  quality_weight: z.number().nonnegative().optional(),
  scoring_mode: z.enum(["breadth", "best_match", "blended"]).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().min(0).optional(),
  min_year: z.number().int().nullish(),
  category: z.string().nullish(),
  institution: z.string().nullish(),
  active_since: z.number().int().nullish(),
  min_citations: z.number().int().nullish(),
});

// PersonResult (agentic shape) -> the econpeople wire row: flat image_url, a 4-field stats
// subset (no primary_category), evidence scores rounded to 5; best_score / nested wikidata
// are dropped (matches search_persons' response construction).
const toWireRow = (r: PersonResult) => ({
  short_id: r.short_id,
  name_full: r.name_full,
  workplace_name: r.workplace_name,
  workplace_institution: r.workplace_institution,
  homepage: r.homepage,
  image_url: r.wikidata.image_url,
  score: r.score,
  overlap_weight: r.overlap_weight,
  n_matched: r.n_matched,
  stats: {
    n_works_in_corpus: r.stats.n_works_in_corpus,
    total_citations: r.stats.total_citations,
    first_year: r.stats.first_year,
    last_year: r.stats.last_year,
  },
  evidence: r.evidence.map((e) => ({
    handle: e.handle,
    title: e.title,
    journal: e.journal,
    year: e.year,
    score: round5(e.score),
  })),
});

personRoute.post("/search", requireKey("rest"), async (c) => {
  const started = performance.now();
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = personSearchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const b = parsed.data;

  const scoringMode = b.scoring_mode ?? "breadth";
  const qualityWeight = b.quality_weight ?? 0.3;
  const categories = csv(b.category);

  const db = await getCorpusDb();
  const results = await personSearch(db, {
    query: b.query,
    maxK: b.limit ?? 25,
    kPapers: b.k_papers ?? 1000,
    offset: b.offset ?? 0,
    scoringMode,
    qualityWeight,
    minYear: b.min_year ?? null,
    journalFilter: categories,
    institution: b.institution ?? null,
    activeSince: b.active_since ?? null,
    minCitations: b.min_citations ?? null,
  });

  // Best-effort logging (Plumber wraps log_person_search in tryCatch).
  try {
    const appdata = await getAppDataDb();
    const queryHash = canonicalHash8([
      ["query", b.query],
      ["scoring_mode", scoringMode],
      ["quality_weight", qualityWeight],
      ["min_year", b.min_year ?? null],
      ["category", categories],
      ["institution", b.institution ?? null],
      ["active_since", b.active_since ?? null],
      ["min_citations", b.min_citations ?? null],
    ]);
    await logPersonSearch(appdata, {
      ip: clientIp(c),
      queryHash,
      resultCount: results.length,
      top3ShortIds: results.slice(0, 3).map((r) => r.short_id),
      scoringMode,
      flags: {
        hasMinYear: b.min_year != null,
        hasCategory: categories != null,
        hasInstitution: !!(b.institution && b.institution.length > 0),
        hasActiveSince: b.active_since != null,
        hasMinCitations: b.min_citations != null,
      },
      responseTimeMs: Math.round(performance.now() - started),
    });
  } catch {
    /* logging is best-effort */
  }

  return c.json({
    query: b.query,
    scoring_mode: scoringMode,
    quality_weight: qualityWeight,
    n_authors: results.length,
    results: results.map(toWireRow),
  });
});

const personSaveSchema = z.object({
  query: z.string().min(1),
  scoring_mode: z.enum(["breadth", "best_match", "blended"]).optional(),
  quality_weight: z.number().nonnegative().optional(),
  results: z.array(z.unknown()).max(500).nullish(),
});

personRoute.post("/search/save", requireKey("rest"), async (c) => {
  const body = await parseBody(c);
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = personSaveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const b = parsed.data;

  const appdata = await getAppDataDb();
  const hash = await savePersonSearch(
    appdata,
    { query: b.query, scoringMode: b.scoring_mode ?? "breadth", qualityWeight: b.quality_weight ?? 0.3 },
    b.results ?? [],
  );
  return c.json({ hash });
});

personRoute.get("/search/:hash", requireKey("rest"), async (c) => {
  const appdata = await getAppDataDb();
  const saved = await getSavedPersonSearch(appdata, c.req.param("hash"));
  if (!saved) return c.json({ error: "Person search not found" });
  return c.json({
    hash: saved.hash,
    query: saved.query,
    scoring_mode: saved.scoringMode,
    quality_weight: saved.qualityWeight,
    results: saved.results,
    created_at: saved.createdAt,
  });
});

personRoute.get("/lookup", requireKey("rest"), async (c) => {
  const name = c.req.query("name");
  if (!name || name.length === 0) return c.json({ error: "name parameter required" });
  const limit = Number(c.req.query("limit") ?? "20");
  const db = await getCorpusDb();
  return c.json(await lookupPersonsByName(db, name, Number.isInteger(limit) && limit > 0 ? limit : 20));
});

// Person-search telemetry (rest scope, same rationale as the classic /stats/searches).
personRoute.get("/stats/searches", requireKey("rest"), async (c) => {
  const days = Number(c.req.query("days") ?? "30");
  if (!Number.isInteger(days) || days <= 0) return c.json({ error: "days must be a positive integer" }, 400);
  const appdata = await getAppDataDb();
  return c.json(await getPersonSearchStats(appdata, days));
});

personRoute.get("/dailylogs", requireKey("rest"), async (c) => {
  const day = c.req.query("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "day=YYYY-MM-DD required" }, 400);
  const appdata = await getAppDataDb();
  return c.json(await personSearchLogsDay(appdata, day));
});

const papersSort = (v: string | undefined): "year" | "citations" | "journal" =>
  v === "citations" || v === "journal" ? v : "year";

personRoute.get("/:short_id/papers", requireKey("rest"), async (c) => {
  const db = await getCorpusDb();
  const limit = Number(c.req.query("limit") ?? "50");
  const offset = Number(c.req.query("offset") ?? "0");
  const includeOoc = c.req.query("include_out_of_corpus");
  return c.json(
    await personPapers(db, c.req.param("short_id"), {
      sortBy: papersSort(c.req.query("sort_by")),
      order: (c.req.query("order") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc",
      includeOutOfCorpus: includeOoc == null ? true : includeOoc !== "false" && includeOoc !== "0",
      limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
      offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    }),
  );
});

personRoute.get("/:short_id", requireKey("rest"), async (c) => {
  const db = await getCorpusDb();
  const profile = await personProfile(db, c.req.param("short_id"));
  if (!profile) return c.json({ error: "Person not found" });
  return c.json(profile);
});
