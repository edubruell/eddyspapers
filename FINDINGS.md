# Phase-exit review findings

Captured from fresh-context sub-agent reviews at the end of each phase (per PLAN.md §12.4).
Blockers must be resolved before the next phase starts; warnings/nits are addressed opportunistically
or deferred with a note.

---

## Phase 1 — Search core in Hono (reviewed 2026-07-10)

### Blockers (resolved before commit)

- **`persons.ts:169-170` — `Math.max(...spread)` on large array.**
  `Math.max(...candidates.map(...))` can hit the JS call-stack argument limit when `candidates` is
  large (broad query, loose filters). Fixed pre-commit: replaced with `candidates.reduce(...)`.

### Warnings (deferred)

- **`corpus.ts:47` — `INSTALL vss` on a read-only connection.**
  Works today only because the DuckDB extension is already cached on the machine. On a fresh
  install, `INSTALL` will fail because the connection is opened `READ_ONLY`. Fix: run `INSTALL vss`
  once through a short-lived writable connection (or a setup script) before opening the read-only
  pool; the read-only conns then need only `LOAD vss`. Defer to Phase 5 (the deploy window is the
  right moment to verify a clean-machine setup).

- **`corpus.ts:54` — round-robin pool off-by-one.**
  `cursor` starts at 0 and the first `nextConn()` call increments before returning, so `conns[0]`
  is never used — effective pool size is N-1. Fix: initialise `cursor = -1` (or post-increment).
  Low blast-radius (pool still works, just slightly smaller than intended); fix in Phase 2.

- **`guide.ts:80` — corpus guide cache holds a stale DB handle after a hot-reload.**
  `buildCorpusGuide` captures the `db` argument on first call and caches forever. If the corpus
  snapshot is swapped without a service restart, the cached guide serves the old snapshot date and
  counts. Fix: export a `clearCorpusGuideCache()` function; the snapshot-swap path (Phase 5) must
  call it. Add a TODO comment at the cache site now so it isn't missed.

- **`papers.ts:276-291` — `verifyReferences` uses a `for…of` loop with a mutable accumulator.**
  The only place in the module that breaks the effect/pipe + no-mutation style (justified by the
  sequential-per-entry semantics documented in the comment). Acceptable as-is; add an explicit
  comment marking the intentional deviation so the style reviewer doesn't flag it again.

- **`persons.ts:156` — SQL uses string interpolation for `whereSql` instead of the Fragment pattern.**
  Safe today (fragments are built from trusted literals, never user input), but inconsistent with
  the `paperFilters` Fragment approach in `papers.ts`. Align in Phase 2 when touching the person
  search internals.

- **`data_verbs.R:31-32` — `semantic_search` interpolates `journal_name` directly into SQL.**
  `sprintf("LOWER(a.journal) LIKE LOWER('%%%s%%')", journal_name)` is an injection surface if a
  script author passes a user-controlled string. The Node port uses parameterised binding. Fix
  during the next sandbox hardening pass (not Phase 1 work).

- **`backend/R/persons.R:511` — `IN (...)` built with string interpolation + `dbQuoteString`.**
  Safe because `dbQuoteString` quotes each value, but the same pattern was replaced elsewhere for
  good reason. Switch to parameterised binding when next touching this function.

- **`app.ts:27` — `/auth/check` sits behind `requireAuth` today.**
  Once Phase 4 lands scoped keys, verify that `/auth/check` uses `requireKey` with the same scope
  as the other routes — it currently accepts the shared `AGENTIC_PASSWORD` even on scoped-key
  builds. Not a Phase 1 concern.

### Nits (low priority, fix when touching the file)

- **`papers.ts:40-46`** — `parseBody` types its argument as `{ req: { json(): Promise<unknown> } }`
  instead of Hono's `Context`. Minor; use `Context` from `hono`.
- **`papers.ts:57`** — Zod errors serialised as `issues` array; `parsed.error.flatten()` is more
  client-friendly. Same in `verifyBodySchema`.
- **`types.ts:5-15`** — `Handle` is capitalised (mirrors the DuckDB column) while every other field
  is snake_case. Intentional parity with Plumber; document it so future ports don't accidentally
  normalise it.
- **`persons.ts:3`** — `import * as R from "remeda"` imports the whole namespace but only `R.sortBy`
  is used. Import only `sortBy` directly.
- **`guide.ts:53-58`** — `journalsByCategory` reduce creates a new object on every iteration (O(N²)
  allocations). 56 rows max so inconsequential; use `Map` or direct property mutation if this ever
  runs over larger inputs.
- **`backend/R/persons.R:543-544`** — intermediate `quality_blend` / `overlap_norm` columns leak
  into the returned data frame. Add a final `dplyr::select(-(quality_norm:overlap_norm))`.
- **`backend/R/persons.R:530`** — `na.rm = TRUE` on `log1p(coalesce(..., 0))` is redundant (coalesce
  already eliminates NAs). Harmless.

### Tests added by the test-extender review

17 new tests written into existing test files (suite now 376 tests / 29 files, all green):

- `papers.edge.test.ts`: `%` and `_` as literal keywords (LIKE escaping), SQL injection via
  `verifyReferences` author/title fields, unicode keywords and author lastnames, large batch
  (200 entries) to verify, `match=all` with absent keyword returns zero, three-field `match=any`
  broadens results.
- `persons.test.ts`: `qualityWeight=0` determinism, `best_match` ordering, `blended` mode
  weak-descending + deterministic, score ≥ `overlap_weight` when quality weight > 0, evidence
  handles are lowercase, `n_matched ≥ evidence.length`.
- Two pre-existing test failures fixed: `%`-keyword count assertion and limit-test anchor keyword.
