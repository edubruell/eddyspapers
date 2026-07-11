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

---

## Phase 2 — MCP adapter + cheap tools (reviewed 2026-07-10)

Two fresh-context sub-agent reviews (code-quality + test-extender) per §12.4. **No blockers.**

### Blockers

None. The implementation is correct against the documented wire shapes; the known hazard classes
(handle-case SQL joins, LIKE-wildcard escaping, empty-input guards, stdout purity on stdio) are all
handled. Full suite green: **426 passed / 4 skipped (32 files)**.

### Fixed during the review pass

- **`resources.ts` — `?limit=N` on cites/citedby (§7.6) can't be wired cleanly.** The SDK
  `ResourceTemplate` matcher rejects any URI carrying a query string the template doesn't declare, and
  the `{?limit}` form makes the param mandatory (breaking the common no-limit read). Reverted the
  passthrough; resources return the default cap (50). `01_design.md` §7.6 updated to drop `?limit=N`;
  a test now pins the "query string ⇒ resource not found" behaviour so it isn't mistaken for a bug.
- **`routes/mcp.ts:14` — `.all("/")` served only `/mcp`, not `/mcp/`.** Some MCP clients normalise to
  a trailing slash. Switched to `.all("*")`; both paths verified to complete the initialize handshake.
- **`tools.ts` — `corpusGuide(db) as unknown as Record<…>` double-cast.** Replaced with an object
  spread (`ok({ ...guide })`) so the guide shape stays type-checked.
- **Stale test comment** in `tests/routes/mcp.test.ts` ("streams as SSE") corrected to
  `enableJsonResponse` mode.

### Warnings (deferred)

- **`server.ts` builds a full MCP server (tool/resource/prompt registration) per request.** Required
  by the SDK's stateless transport (it refuses reuse); cheap in absolute terms since the DuckDB pool is
  a shared singleton, but zod schema construction re-runs each call. Acceptable at Phase-2 volumes;
  revisit if HTTP MCP QPS grows and the SDK offers a registration/transport split.
- **`tools.ts` — `a.fields as KeywordField[]` / `a.entries as BibEntry[]` casts.** Safe narrowing (the
  zod enums match the service unions exactly) but compiler-unverifiable. Acceptable — the schemas are
  the source of truth. Align if the service types and schemas ever drift.
- **`routes/mcp.ts` auth is the shared password (`requireAuth`), not scoped keys.** Phase 4 swaps in
  `requireKey('mcp')` + per-key rate limits (PLAN §D); the route comment already flags this.

### Nits (low priority)

- **`verifyReferences` (papers.ts) uses a `for…of` accumulator** — the one imperative loop, justified
  and commented (sequential per-entry semantics; parallelising would contend for the small pool). Keep.
- **`guarded` in `tools.ts` doubly covers zod validation** (the SDK already turns a schema throw into
  an `isError` result before the handler runs). Harmless.

### Doc updates applied (§10)

`01_design.md` §7.2 (two-doors → six-tool surface, with Phase 2/3 split), §7.6 (`?limit=N` dropped),
§7.8 (cache TTL: snapshot-swap, not nightly), §7.9 (Phase-2 shared-password gate + nginx note).
PLAN.md progress log extended with the Phase 2 entry.

### Tests added by the test-extender review

34 new tests (suite now 426 passed / 4 skipped, 32 files), all driven over the in-memory MCP transport
against the fixture (Ollama-free — `find_papers`/`find_people` asserted at schema level only):

- `tests/mcp/edgecases.test.ts` (30): per-tool `inputSchema`/`required` round-trips; malformed
  payloads → `isError:true` (missing/mistyped `query`, empty/oversized `entries`, out-of-range
  limit/offset, unknown enums, unknown tool name); SQL-only parity (`match:"all"`⊆`"any"`,
  `order_by:"citations"`, disjoint offset pages, text ⇄ `structuredContent` equality, summary counts);
  resource-URI parsing (colon handles round-trip, missing handle ⇒ null/empty not crash, `/cites`
  doesn't collide with the base template, unregistered scheme rejects); prompt arg handling + unknown
  prompt name.
- `tests/routes/mcp.test.ts` (+4): Accept-header 406 cases, malformed JSON body ≥400, `tools/list`
  over the HTTP transport returns a JSON-RPC frame.
- `tests/mcp/server.test.ts` (smoke): initialize/capabilities/instructions, `tools/list`, SQL-only
  tool calls, resource reads, prompt expansion, plus the `?limit` "not found" pin.

---

## Phase 3 — `lit_search` over MCP (reviewed 2026-07-10)

Two fresh-context sub-agent reviews (code-quality + test-extender) per §12.4. **No implementation
blockers** — the code-quality reviewer confirmed the production code correct against §7.3–7.8 on
first read. The only blocker was a transiently-red suite (test-harness defects), which the
test-extender fixed while extending coverage.

### Blockers

None in the shipped code. Delivered: `src/agent/bundle.ts` (the run-events → §7.5 bundle reducer,
shared by the tool and the searches resources), `src/mcp/litSearch.ts` (the `lit_search` tool), the
`agenticsearch://searches/{id}[/script|/bibtex|/papers|/sections/{sid}]` resources in
`src/mcp/resources.ts`, and `lit_review` re-pointed at `lit_search`. Full suite green:
**473 passed / 4 skipped (35 files)**.

### Fixed during the review pass

- **`litSearch.ts` finalize now mirrors the web `/chat` `hasDone` guard.** Was `errored ? "error" :
  "done"`; a future `runAgent` path that returns without a `done`/`error` would have cached a
  truncated run as `done` and served it forever from the §7.8 cache. Now a run is finalized (and
  cacheable) as `done` **only** if a terminal `done` was emitted and no non-recoverable error.
- **`resources.ts` search-section handler now decodes `{sid}`** (`decodeHandle`, mirroring the paper
  resource). The SDK's `ResourceTemplate` does not percent-decode path segments, so a client that
  encoded a reserved char in a section id (`+` → `%2B`) could not reach the section. Latent only —
  our generated ids (`sem-1`, `kw-1`, …) never need encoding — but fixed and pinned by a test the
  extender had filed as a `.skip` product-gap.
- **Dropped the unused `runHasContent` export** (and its test) flagged as dead code — the cache-serve
  decision keys on `status === "done"`, which correctly includes legitimately-empty completed runs
  (re-running them would yield the same empty result).
- **Test-harness fixes** (test-extender): a naive `split(",")` CSV helper that broke on the quoted
  multi-author cell, and a zero-result assertion that expected a synthesiser call runAgent
  short-circuits.

### Warnings (deferred)

- **Cache key omits `must_include` and `refine`** (`src/agent/cache.ts`, shared with `/chat`). §7.8
  specifies both in the hash; the shipped key hashes only `{brief, categories, min_year,
  db_snapshot_date}`, so two `lit_search` calls differing only in those collide on `search_id`.
  Pre-existing and harmless on the web path, but Phase 3 is the first surface exposing both as tool
  inputs. Widen the hash in **Phase 4** (with the key registry); `01_design.md` §7.8 now documents
  the narrower shipped key.
- **Progress notifications buffer under the hosted HTTP transport.** With `enableJsonResponse`
  (server.ts) the streamable-HTTP path returns notifications with the reply rather than streaming
  them live; stdio and any SSE-mode path deliver them incrementally. Acceptable; a session-aware
  streaming HTTP path is a later revisit if live progress over hosted HTTP is wanted.
- **Per-key rate limits + single-concurrent `lit_search` cap (§7.9) are Phase 4**, correctly absent
  here — `/mcp` sits behind the shared-password `requireAuth` for now.

### Nits

- **`getSearchDb` singleton has a first-call race** (`db/singleton.ts`, instance-cached unlike the
  promise-cached `getCorpusDb`). Pre-existing, idempotent `CREATE TABLE IF NOT EXISTS`, low-impact.
  Align with the corpus pattern when next touching the file.

### Doc updates applied (§10)

`01_design.md` §7.2 (`lit_search` shipped Phase 3), §7.4 (progress table gains `strategy`/`revise`
rows + a Phase-3 status note on buffered HTTP + skip_clarify default + needs_clarification), §7.5
(structuredContent gains `strategy` always + optional `persons`), §7.6 (searches resources marked
shipped, with mime types), §7.8 (narrower shipped cache key documented, widening deferred to Phase 4).
PLAN.md progress log extended with the Phase 3 entry.

### Tests added by the test-extender review

23 new tests (Phase 3 total 47 pass; full suite 473 passed / 4 skipped, 35 files), all hermetic
(pipeline stages mocked like `runAgent.clarify.test.ts`; resources seeded through `getSearchDb` — no
live LLM/R/Ollama):

- `tests/agent/bundle.test.ts` (+10): `max_similarity` = MIN across sections / picked from the
  section that has it / `0` treated as real / empty for keyword-only & orphan papers; `sections` cell
  empty for a paper in no section; year/percentile emitted unquoted; unicode preserved; all-empty
  bundle; person-only run stays paper-CSV-empty; a section referencing a handle with no paper is
  crash-safe.
- `tests/mcp/litSearch.test.ts` (+7): progress steps within 1..5, non-decreasing, reach 5, total
  always 5; distinct `categories`/`min_year` → distinct `search_id`s (no cache collision); an errored
  prior run is **not** served from cache; `must_include`/`categories`/`min_year` reach the writer;
  `assess` consulted only when `refine=true`; zero-result run returns a terminal non-error bundle
  with a header-only CSV.
- `tests/mcp/searchResources.test.ts` (+6): overview of a still-`running` run; `/script` of a running
  run; regex-metachar section id matched literally (not as a pattern); percent-encoded section id now
  resolves; CSV quotes/commas/newlines round-trip through `/papers`.

---

## Phase 4 — Keys & limits (reviewed 2026-07-10)

### Code-quality review — no blockers

The reviewer confirmed correctness against §D1/§7.9 on every load-bearing axis: SHA-256-only
storage (plaintext never logged/listed/errored), 401 unknown/revoked vs 403 wrong-scope, the
empty-registry-plus-no-password pass-through, the grandfathered legacy password (constant-time
compare, never hashed), cache-hit-before-quota, the concurrency gauge released in `finally`,
single-opener appdata, and both `computeSearchId` call sites widened. Warnings/nits resolved:

- **W1 (fixed).** `lit_search` served a cached result *before* the `lit_search` scope check, so
  an `mcp`-only key could read back another caller's completed run (cache is keyed on
  brief+snapshot, not on key). Moved the scope check **above** the cache lookup; the rate-limit
  acquire stays after it, so cache hits remain quota-free. §7.9 updated.
- **W2 (fixed).** The grandfathered password was frozen at `env.ts` import while the appdata path
  was read live — an asymmetry that made the gate un-toggleable at runtime/tests. `keys.ts` now
  reads `process.env.AGENTIC_PASSWORD` live, matching `appdata.ts`.
- **W3 (documented).** A registry reload failure is fail-closed (the awaiting request errors,
  never opens the gate); noted in §7.9. No stale-serve fallback — acceptable for the preview.
- **N1 (fixed).** Dropped the redundant `satisfies … as` double-cast for a module-scope
  `DEFAULT_SCOPES: Scope[]`. **N4 (fixed).** `keys list` CLI now prints `rate_limit_overrides`.
- **N2/N3 (by-design, left):** overrides accept arbitrary keys (a typo'd class silently no-ops)
  and adjust only `perHour` — both match §7.9/API_KEYS.md wording.

### Test extender

Added edge-case coverage (all hermetic — search layer + corpus/appdata mocked, no live
LLM/R/Ollama/network): timing-safe compare (same-length-wrong vs wrong-length both 401, through
the app and the registry); the empty-string-is-not-legacy case; the registry TTL staleness
contract (a key written straight to the store is invisible until force-refresh; a revoked key
still resolves from a warm cache until the next refresh); `x-api-key`/`x-agentic-key`/Bearer all
accepted with Bearer preferred; scope escalation across routes (mcp-only key → rest route 403);
a cache HIT consuming no `lit_search` quota even with the concurrency slot held; the cheap-tool
hourly cap at the boundary (Nth allowed, N+1th blocked, no downstream query on block) per key;
appdata list ordering + revoke-nothing → 0. Final suite: **527 passed / 4 skipped, 41 files**;
clean `tsc` + build. No product bugs surfaced beyond the reviewer's W1 (already fixed).

### Doc updates applied (§10)

`01_design.md` §7.4 (single-concurrent cap shipped), §7.8→§7.9 cross-ref, §7.9 (full key-registry
concretisation: appdata table, `requireKey(scope)` matrix, rate-limit classes, scope-before-cache,
fail-closed reload, CLI-over-`/admin`), operator-telemetry note (`requireKey('admin')`). New
`agentic/agentic_backend/API_KEYS.md` (client-setup guide). PLAN.md progress log extended with the
Phase 4 entry.

### Follow-ups (raised + resolved 2026-07-11)

- **Key admin UI — BUILT.** A small operator page ships at **`agentic_frontend/src/pages/admin.astro`**
  (`/admin`) backed by `components/admin/KeyAdmin.jsx`, over the existing three `requireKey('admin')`
  routes — **no new backend surface**. It lists keys (label/scopes/id/created/state, revoked hidden by
  default), mints with a free-text label + scope pills, reveals the plaintext **once** in a copy modal,
  and revokes with an inline confirm. The admin token lives in `localStorage` under a key separate from
  the search-app token (`getAdminKey`/`setAdminKey` in `lib/api.js`), so a search-UI user never carries
  admin rights. On 401/403 the page drops to a lock screen. Verified end-to-end via `app.request()`
  (401 no-token · 201 mint · 403 wrong-scope · revoke · active/all counts · CORS preflight allows
  `DELETE` + `Authorization`) and a Playwright e2e (`tests/e2e/admin.spec.mjs`, green). `API_KEYS.md`
  gained an "admin web page" section. **Bootstrap caveat** (inherent to the global `isEnabled()` gate,
  not new): minting the first key enables the gate, so keep `AGENTIC_PASSWORD` set (prod) or make the
  first key `admin`-scoped (dev) or you lock yourself out of the page.
  - *Design note:* keeping API keys an **MCP-only** concern once the web product goes password-free is a
    separate Phase-5 rewiring — drop `requireKey('rest')` from the web routes (public + per-IP limit),
    keep `requireKey('mcp')`/`requireKey('admin')`. Not done here; flagged for the deploy window.
  - *Code-quality review (fresh-context sub-agent) — no blockers, security clean* (token only ever in the
    `Authorization` header, never a URL; stored under `agentic_admin_key`, separate from the search-app
    `agentic_key`; minted plaintext shown once, list never returns `key`). Three warnings **fixed**:
    (W1) a mint/revoke that 401/403s now drops to the lock screen — `createAdminKey`/`revokeAdminKey`
    attach `.status` and the handlers branch on it (an admin token can be revoked mid-session);
    (W2) unlock now populates the table from the probe response instead of firing a second list request;
    (W3) `adminReq` guards `JSON.parse` so an HTML 502/504 from the reverse proxy surfaces as the status,
    not a "Unexpected token" crash. E2e extended: reveal-is-one-shot (plaintext gone + absent from the
    table), the `?all=1` request contract, and sign-out clears storage + re-locks — 2 specs green.

- **Pre-existing e2e failure in `run.spec.mjs` — FIXED (subagent pass, out-of-scope by request).**
  Root cause was two-fold: (1) a real harness gap — the mock server (`tests/mock-server.mjs`) had **no
  `GET /auth/check` route**, so the `Gate` mount-probe fell through to the 404 catch-all and the app
  stuck on the lock screen (no task box ever rendered); (2) a stale selector — the first assertion
  looked for a `getByText("AGENTIC SEARCH")` text node, but the wordmark is now baked into the logo
  image (`LogoAgentic.jsx` → `logo_agentic.webp`), so there is no such text node. Fixes: added a
  `GET /auth/check → 200 {ok:true}` route to the mock (the mock backend is open), and switched the
  assertion to `getByRole("img", { name: /Agentic Search/i })`; every other assertion in the spec is
  unchanged. Full e2e suite now **3 passed** (`run.spec` 1/1, `admin.spec` 2/2).

---

## Known pre-existing issues (to deal with later)

- **~113 `tsc --noEmit` errors, all in test files — pre-existing, tracked for a cleanup pass.**
  Confirmed present on a clean tree (git-stash isolation) *before* any Phase-5 work, so not introduced
  by the backend-port. `vitest` transpiles via esbuild without a type-check, so the full suite still
  runs green — this is a `tsc`-gate-only dirtiness, not a runtime failure. Breakdown by file:
  `tests/agent/bundle.test.ts` (56), `tests/mcp/searchResources.test.ts` (26),
  `tests/mcp/edgecases.test.ts` (15), `tests/mcp/server.test.ts` (6),
  `tests/mcp/tools.limits.test.ts` (1). Dominant cause: the `StreamEvent` discriminated union rejects
  the test fixtures' object literals under `Omit<StreamEvent, "seq">` (TS2353 "may only specify known
  properties" — 68×; plus TS2345 24×, TS2339 11×, TS2556 1×), i.e. the test event builders need a
  per-variant type or a discriminant so the union narrows. **Action:** fold a dedicated
  fix into the Phase-5 M5 test-extender pass (or a standalone cleanup) — do NOT let it block a phase's
  `tsc` gate in the meantime; re-baseline the count so any *new* Phase-5 tsc error is visible against it.
