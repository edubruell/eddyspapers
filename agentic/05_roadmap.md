# Agentic Search — Roadmap (Note 5)

**Companion to:** `00_overview.md`, `01_design.md`, `02_implementation_plan.md`, `03_interface.md`, `04_prompts.md`.
**Scope:** the multi-phase plan of attack — what gets built, in what order, against which acceptance criteria, with which dependencies. Every task here resolves back to a section in one of the other four docs; nothing new is decided in this file.

The phases are sequential by **default** but several pieces can be parallelised once the R sandbox (Phase 1) is solid. Phase tags below show this explicitly.

Legend: 🟢 trivial · 🟡 medium · 🔴 hard or risky · ⏱ rough effort · ⚠ blocker for downstream phase.

---

## Phase 0 — Project scaffolding 🟡 ⏱ ½ day ✅

Set up the empty repo skeleton so every later phase has somewhere to land code.

- [x] Create `agentic/` directory tree per `02 §1` (`agentic_backend/`, `agentic_frontend/`, `r/`).
- [x] Add root-level `pnpm-workspace.yaml`.
- [x] `agentic_backend/`: `package.json`, `tsconfig.json`, `tsx` watch script, Hono "hello world" on `:8001`.
- [x] `agentic_frontend/`: `astro create` template, Tailwind set up.
- [x] `agentic/r/eddysearch.sandbox/`: bare `DESCRIPTION`, `NAMESPACE`, empty `R/`, `devtools::load_all()` works.
- [ ] Root `agentic/README.md` pointing at `00_overview.md` and the four design docs.
- [ ] `.gitignore` covering `node_modules/`, `dist/`, `.astro/`, `data/`, R `.Rcheck/`.

**Acceptance:** `pnpm dev` boots Hono on `:8001`; `pnpm --filter agentic_frontend dev` boots Astro on `:4322`; `devtools::load_all("agentic/r/eddysearch.sandbox")` exits clean.

---

## Phase 1 — R sandbox foundation ⚠ blocks 2–4 · 🔴 ⏱ 3–5 days ✅

The `eddysearch.sandbox` R package is the heart of the design. Until it exists, nothing else can be tested end-to-end.

### 1.1 Data verbs (`01 §3.2`) ✅

- [x] `connect_db()` — opens the read-only copy of the latest updated DuckDB with all hardening pragmas applied (`01 §3.4`). Single connection per process.
- [x] `semantic_search(query, max_k, min_year, journal_filter, journal_name)` — wraps the existing `eddyspapersbackend::semantic_search` semantics, returns a tibble with the documented columns.
- [x] `sql_query(sql, params = list())` — runs `SELECT_NODE`/`SET_OPERATION_NODE` only after DuckDB parse-tree validation (`01 §3.4`), auto-injects `LIMIT 5000` when absent.
- [x] `cites(handle, limit = 50)`, `citedby(handle, limit = 50)` — joins against `cit_internal`.
- [x] `handle_stats(handles)` — read from `handle_stats` table.
- [x] `versions(handle)` — from `version_links` table (columns `source`, `target`, `type`); returns linked papers with metadata.
- [x] `bib_for(handles)` — flat tibble of `bib_tex` strings.
- [x] `journals()`, `categories()` — reference tibbles for discovery.
- [x] `paper_url(handle)` — two-tier resolver: `articles.url` then IDEAS-from-handle fallback (`01 §4.4`).

### 1.2 Output verbs + FD-3 event writer (`01 §3.2`, `§4.5`, `§4.10`) ✅

- [x] `emit_event(list)` — writes one JSON line to FD 3.
- [x] `emit_section(title, df, n = 25, note = NULL)` — buffers a labelled section; resolves new handles via in-process dedup set; emits a `paper` event per new handle then the `section` event.
- [x] `emit_note(markdown)` — free-form commentary.
- [x] `emit_bibtex(handles)` — accumulates handles, emits the final `bibtex` event.
- [x] `emit_progress(label, current = NULL, total = NULL)` — exposed for model use but rarely needed.
- [x] Internal wrapping of every data verb to emit start/end `progress` events automatically.

### 1.3 Helpers (`01 §3.2`) ✅

- [x] `fmt_row(df, i)` — single-row formatter.
- [x] Default `format_results()` — used if the model doesn't write its own.

### 1.4 Tests ✅

- [x] `testthat` suite: SQL parse-tree validator golden-file tests, emit event stream tests, paper_url tests, helpers tests.
- [x] FD-3 capture test: tempfile-based capture in testthat; Rscript end-to-end exercised via corpus runner.
- [x] SQL parse-tree validator: comprehensive golden-file tests for legal/illegal SQL.
- [x] `agentic/r/run.R` — sandbox script entrypoint for `Rscript --vanilla` invocation.

**Acceptance:** `run.R` + good corpus scripts constitute the Mode-A hand-written examples; corpus runner (`run_corpus_tests.R`) verifies end-to-end.

---

## Phase 2 — AST allowlist (`check.R`) ⚠ blocks 5 · 🔴 ⏱ 2–3 days ✅

Per `01 §3.3`.

- [x] `agentic/r/check.R`: parse user script, walk AST, classify every node.
- [x] Allowlist constants: base R glue, dplyr, stringr, tidyr, purrr, and the `eddysearch.sandbox` exports.
- [x] Hard-rejected calls list (~70 functions) with informative error messages per `04 §6` discipline.
- [x] `<<-`, `:::`, `::` (except `magrittr::%>%`), `do.call` with non-literal-string first arg, `assign`/`get` rejected.
- [x] String-literal scan for absolute paths outside `/tmp/sandbox-out/`.
- [x] Returns `{ok: true}` or `{ok: false, reason, offending_node, hint}` JSON to stdout.
- [x] `do.call("fn", ...)` checked against allowlist (not just BLOCKED) — prevents non-allowlisted functions via do.call string path.

### 2.1 Test corpora ✅

- [x] `agentic/r/tests/ast/good/` — 7 scripts (semantic search, citation chains, journal scans, author lookups, purrr/pipe patterns, advanced SQL joins). All validate.
- [x] `agentic/r/tests/ast/bad/` — 17 adversarial scripts covering: library(), system(), eval(parse()), do.call variants, <<-, :::, ::, writeLines, cat, readLines, absolute paths, assign/get, unknown functions. All reject with non-empty hints.
- [x] `agentic/r/tests/ast/run_corpus_tests.R` — CI-runnable corpus runner, exits 0 on full pass.

**Acceptance:** 7/7 good scripts validate; 17/17 bad scripts rejected with hints; new bad example addable in <5 min.

---

## Phase 3 — TS sandbox runner ⚠ blocks 5 · 🟡 ⏱ 2 days ✅

Per `02 §2 sandbox/` and `01 §3.5`.

- [x] `bin/run-sandbox.sh` — `systemd-run --scope --uid=eddysandbox` with all the hardening flags from `01 §3.5`; macOS/dev fallback to plain Rscript.
- [x] `bin/check.sh` — `Rscript --vanilla check.R <script>`.
- [x] `src/sandbox/runSandbox.ts` — spawn the script via `bin/run-sandbox.sh`, wire FD 3 to a line reader, parse one JSON event per line, push to an `onEvent` callback. Returns `{events, exitCode, stdout, stderr, timedOut}`.
- [x] `src/sandbox/checkScript.ts` — spawn `bin/check.sh`, parse JSON, return typed result.
- [x] `src/sandbox/events.ts` — zod schemas, type guards + `seq` assignment.
- [x] `src/sandbox/snapshot.ts` — resolve current copy-of-DB path via env-var chain (`DB_SNAPSHOT` → `PAPER_SEARCH_DB` → `PAPER_SEARCH_DATA_ROOT` → relative default → production path); warn if older than 7 days.

### 3.1 Tests

- [x] End-to-end "TS spawns R, gets events back" test against the same script used in Phase 1's acceptance.
- [x] Wall-clock timeout test: a deliberate `Sys.sleep(60)` script is killed at 5s in tests (30s in production).
- [x] Memory cap test: Linux-only (`it.skipIf(process.platform !== 'linux')`); skipped on macOS.
- [x] FD-3 truncation test: a script that emits >200 B (configurable) of events triggers the truncation error event gracefully.

**Acceptance:** the same hand-written script from Phase 1 runs via TS, the orchestrator sees the same event sequence, ulimits are demonstrably enforced.

---

## Phase 4 — LLM layer + writer stage 🟡 ⏱ 3 days ✅

Per `02 §2.1` and `04 §1–§3`.

### 4.1 OpenRouter client (`02 §2.1`) ✅

- [x] `src/llm/client.ts`: `createOpenRouter({ apiKey })`.
- [x] `src/llm/stream.ts`: `streamText` helper with cache_control passthrough.
- [x] `src/llm/structured.ts`: `generateObject` wrapper with zod schemas.
- [x] Per-call logging of `prompt_tokens_details.cached_tokens` to `data/llm_telemetry.ndjson`.

### 4.2 Cached prompt corpus (`04 §2`) ✅

- [x] `src/prompts/apiReference.ts` — verb signatures from `eddysearch.sandbox`, exact DB category labels.
- [x] `src/prompts/journalCategories.ts` — ZEW tier table with **exact DB category strings** (verified against live DB).
- [x] `src/prompts/semanticQueryGuide.ts` — mechanism-not-keyword guidance + bad/good examples.
- [x] `src/prompts/examples.ts` — three worked scripts adapted to `emit_*` API.
- [x] `src/prompts/writerRules.ts` — hard rules + one-line why clauses.
- [x] `src/prompts/clarifier.ts`, `src/prompts/synthesizer.ts` — system prompts for later stages.
- [x] `src/prompts/assemble.ts` — memoized assembly, `providerOptions.openrouter.cacheControl` at message level.
- [x] `src/env.ts`, `src/agent/models.ts` — env-configurable model registry (default: claude-haiku-4-5).
- [x] `.env` with `OPENROUTER_API_KEY` and `PAPER_SEARCH_DB` pointing at live DB.

### 4.3 Writer stage (`02 §2`, `04 §3`) ✅

- [x] `src/agent/stages/writeScript.ts` — `generateObject` against `{script: string}` schema; injects `<brief>`, `<filters>`, `<db_snapshot>` blocks.
- [x] Retry path: appends `<previous_attempt>` + `<rejection>` blocks; switches to `writerRetry` model after two failures.
- [x] Token telemetry surfaced on every call (cached / total logged to NDJSON).

### 4.4 Eyeball harness ✅

- [x] `pnpm eyeball "<brief>"` — runs writer → validator → sandbox → pretty-prints event log.
- [x] End-to-end tested with live 12 GB DuckDB; exit 0, 54 papers on first run.
- [x] `pnpm eyeball --script=path/to/script.R` — direct-script mode: skips the LLM and runs a raw `.R` file against the snapshot, for iterating on a hand-fixed failing script.
- [x] On any failure (validation, timeout, non-zero exit) the script + full stderr + events JSON are dumped to `data/agentic/debug/<timestamp>/` and the path is printed, so failures are inspectable without re-running.

### 4.5 Fixes discovered during integration ✅

- [x] `eddysearch.sandbox/R/connect.R` — load `json` and `vss` extensions **before** the security lockdown pragmas (both need to be available before `lock_configuration = true`).
- [x] `eddysearch.sandbox/R/data_verbs.R` — match the backend's binding pattern: build all WHERE filters as SQL string literals via `sprintf`/`shQuote`, bind only `list(list(vec), max_k)`.
- [x] `tsconfig.json` — removed `rootDir: "src"` (pre-existing bug; blocked `tests/` and `scripts/` from type-check).

### 4.6 Input guardrails ✅

Two layers before an expensive write+sandbox run:

- [x] **Pre-flight validation** (`src/agent/stages/writeScript.ts`) — rejects synchronously, no LLM cost:
  - Brief < 15 chars or > 2000 chars
  - Fewer than 3 word-like tokens (pure symbols / numbers / gibberish)
- [x] **Clarifier rejection path** — extended schema: `done | question | reject(reason)`.
  Updated clarifier prompt instructs the model to reject briefs that are clearly not
  economics literature searches (recipes, coding help, personal advice, pure nonsense)
  with a short user-friendly explanation. Wired into the pipeline in Phase 6 (`runAgent`).

**Caching note (updated):** At ~50–100 searches/day, inter-search cache hits are uncommon (TTL 5 min, average gap >10 min). Caching pays off **within a single run**: writer retry (same 6.7k-token system prompt, seconds apart) and synthesiser (same 2k prompt, fired 30–60s after write). Cross-user caching is a bonus, not the primary economic justification.

**Acceptance:** all samples tested produce valid scripts on first attempt; exit 0 on full pipeline with live DB.

---

## Phase 5 — Cost benchmark & model lock-in 🔴 ⏱ 2 days ✅

Gate before committing to the cheap-model defaults (`02 §2.1`).

- [x] Seed corpus: 10 diverse briefs covering context-paste, detailed mechanism, very broad, targeted+pills, author focus, journal prestige, citation-seeking, cross-discipline, country-specific, methodological — `tests/benchmarks/briefs.jsonl`.
- [x] Harness: `scripts/benchmark.ts` — writer + validator + sandbox; qualitative pass via `scripts/qual.ts` (section titles, sample papers, full scripts).
- [x] Per-candidate model run (writer stage): `deepseek/deepseek-v4-flash`, `qwen/qwen3.6-35b-a3b`, `anthropic/claude-haiku-4-5`, `google/gemini-3.5-flash`. Prices queried live from OpenRouter API.
- [x] Metrics collected: validity rate, paper yield per brief, write latency, cost/run. Qualitative diff on b01 + b07.
- [x] Model picks locked in `.env`.

**Results summary (2026-05-21):**

| Model | Validity | Avg papers | Avg cost/run | Notes |
|---|---|---|---|---|
| `qwen/qwen3.6-35b-a3b` | **10/10** | 51.3 | **$0.0026** | Best citation ordering, clean sections |
| `anthropic/claude-haiku-4-5` | **10/10** | 49.6 | $0.0132 | Faster (11s), better citation graph use |
| `deepseek/deepseek-v4-flash` | 7/10 | — | $0.0010 | 2 syntax failures + 2 zero-result runs; eliminated |
| `google/gemini-3.5-flash` | 8/10 | — | $0.0320 | Verbose scripts, 0-paper on b02+b05; eliminated |

**Locked defaults:**
- `MODEL_WRITER` = `qwen/qwen3.6-35b-a3b` — 5× cheaper than Haiku, same validity, better brief-reading (citation ordering, targeted author SQL)
- `MODEL_WRITER_RETRY` = `anthropic/claude-haiku-4-5` — fast, reliable for attempt 3
- `MODEL_CLARIFIER` = `anthropic/claude-haiku-4-5` — speed matters for short turns
- `MODEL_SYNTH` = `anthropic/claude-haiku-4-5` — revisit after Phase 6 with real synthesis quality data

**Per-query cost at median brief (~7k prompt tokens):** $0.0026 writer + retry amortised ≈ **$0.003** — well under $0.02 target.

**Acceptance:** Eddy signed off on model picks (2026-05-21). ✅

---

## Phase 6 — Full pipeline (`runAgent`) + SSE 🟡 ⏱ 3 days ✅

Per `02 §2.2` and `01 §4`.

### 6.1 Stages

- [x] `src/agent/stages/clarify.ts` — single optional turn, structured output per `04 §4.2`.
- [x] `src/agent/stages/validate.ts` — wraps `checkScript.ts`, surfaces typed result.
- [x] `src/agent/stages/execute.ts` — wraps `runSandbox.ts`, translates R-side FD-3 events into wire `StreamEvent`s.
- [x] `src/agent/stages/synthesize.ts` — streams markdown using the synthesiser cached prompt (`04 §5`); injects `<brief>`, `<script>`, `<sections>`, `<papers>`, `<bibtex>` blocks.
- [x] `src/agent/runAgent.ts` — orchestrates all five stages, emits the full `StreamEvent` taxonomy from `01 §4.3`, assigns `seq`.
- [x] `src/agent/cache.ts` — `search_id` hash over `{brief, categories, minYear, db_snapshot_date}`; checked against `searches` cache table.
- [x] `src/db/searches.ts` — tiny read-write DuckDB at `data/agentic/searches.duckdb`.
- [x] `src/agent/types.ts` — shared wire types: `StreamEvent`, `Stage`, `Paper`, `Section`, `AgentInput`, `StreamEventPayload`.

### 6.2 Transport

- [x] `src/stream/bus.ts` — in-memory pub/sub keyed by `search_id`, ring buffer with replay.
- [x] `src/stream/sse.ts` — Hono SSE helper, heartbeat every 15s, `Last-Event-ID` replay.
- [x] `src/routes/chat.ts` — `POST /chat` kicks off a run, returns `{id}`. Cache hit returns 200 immediately.
- [x] `src/routes/stream.ts` — `GET /chat/:id/stream` subscribes to the bus.
- [x] `src/routes/searches.ts` — `GET /searches/:id` returns the cached structured payload.

### 6.3 Event recording for frontend dev

- [x] CLI: `pnpm tsx scripts/record-events.ts <brief> > fixture.jsonl` — drives a real run and dumps every event for the frontend to replay against. (`02 §7` step 6.)

**Key implementation notes:**
- Clarifier is non-blocking: if it returns a question, it's emitted as an `assistant` event while the pipeline proceeds optimistically.
- `writeScript` handles retries internally; `validate` stage surfaces the final outcome for the UI stepper only.
- Script token streaming deferred (single `script` event after write succeeds); add streaming in a future iteration.
- Searches DB at `data/agentic/searches.duckdb`; events stored as JSON array in a TEXT column.

**Acceptance:** running `POST /chat` then subscribing to the SSE stream from `curl` reproduces a full event sequence for a representative brief; the recorded fixture is replayable.

---

## Phase 7 — Web frontend (`agentic_frontend/`) 🟡 ⏱ 4–5 days · 🟢 MVP RUNNING LOCALLY

Per `03_interface.md` end-to-end. **Can start in parallel with Phase 6** as soon as the event fixture from §6.3 exists.

**MVP status (2026-06-05):** a working Astro/React app consumes the live SSE stream and renders the full run (stepper → strategy → synthesis → evidence sections → papers). Verified end-to-end against the live 12 GB DuckDB + R sandbox on this laptop (`pnpm dev` → backend `:8001` + frontend `:4321`), and a hermetic Playwright e2e (`pnpm --filter agentic_frontend test:e2e`) replays a recorded SSE fixture through the real UI. The script panel was **replaced by a plain-language `StrategyPanel`** (`03 §3.2`); the R script is never surfaced. Remaining items below (zod-validated stream, `/c/[id]` permalink page, DatabaseFooter, BibtexDrawer/ErrorToast as separate primitives, server-rendered artifacts) are unchecked polish.

### 7.1 Palette + primitives (`03 §1`)

- [ ] Read the actual CSS variables out of `frontend/src/styles/` (or the existing app's stylesheet) and overwrite the `03 §1.1` table.
- [ ] Lock in the agentic accent-colour shift (slightly different navy + warmer teal) — `03 §2`.
- [ ] `components/primitives/`: `Card`, `Pill`, `PrimaryButton`, `GhostButton`, `SectionLabel`, `SimilarityBar`, `AdvancedDisclosure`, `DatabaseFooter`. Each visually identical to its `frontend/` counterpart.

### 7.2 Streaming consumer

- [ ] `lib/stream.ts` — `EventSource` wrapper, zod-validates each event, reconnects with `Last-Event-ID`.
- [ ] `lib/store.ts` — reducer-backed store via `useSyncExternalStore`; exhaustive `StreamEvent` switch.
- [ ] `lib/markdown.tsx` — `react-markdown` + `remark-gfm` + a rehype plugin that:
  - rewrites external `<a>` to `target="_blank" rel="noopener noreferrer"` (`01 §4.8`),
  - finds bare `RePEc:…` substrings and turns them into in-page anchors that scroll-to + expand the matching `PaperCard`.

### 7.3 Chat layout (`03 §3`)

- [x] Landing state: centered logo + `TASK` panel (just the brief box — no category pills/advanced disclosure, decided 2026-06-06) + `Run` button + DB footer (date from semantic API).
- [x] Working/results state: collapsed sidebar with logo + TASK textarea (frozen during run) + `Run` + DB footer + `← Semantic mode` link.
- [ ] Right pane reading order (`03 §3.2`): `StageStepper` → `ProgressLine` → `StrategyPanel` (plain-language plan, never the R script — decided 2026-06-05) → `ClarifierBubble` (inline if needed) → `SynthesisPanel` → `ArtifactsToolbar` → `EVIDENCE` divider → collapsed `SectionCard` list.

### 7.4 Components (`03 §11`)

- [ ] `chat/StageStepper.jsx`, `ProgressLine.jsx`, `StrategyPanel.jsx`, `ClarifierBubble.jsx`.
- [ ] `chat/SectionCard.jsx` — collapsed by default, click-to-expand.
- [ ] `chat/PaperRow.jsx` + `chat/PaperCard.jsx` — `PaperCard` visually identical to existing `ResultCard`.
- [ ] `chat/SynthesisPanel.jsx` — markdown streaming, handle linkify, external new-tab links.
- [ ] `chat/BibtexDrawer.jsx`, `chat/ArtifactsToolbar.jsx`, `chat/ErrorToast.jsx`.
- [ ] `logo/LogoAgentic.jsx` — placeholder until Eddy's hand-drawn meerkat ships.

### 7.5 Pages

- [ ] `pages/index.astro` — landing.
- [ ] `pages/c/[id].astro` — single `<SearchChat client:load />` mount.

**Acceptance:** the frontend replays the recorded fixture from §6.3 with full visual fidelity; then connects to a live backend and renders a real run end-to-end. Sibling-app feel passes a quick side-by-side check with the existing `frontend/`.

---

## Phase 8 — Downloadable artifacts 🟢 ⏱ 1–2 days

Per `01 §4.9` and `02 §2 artifacts/`.

- [ ] `src/artifacts/md.ts` — synthesis + section listings, simple string concat.
- [ ] `src/artifacts/bib.ts` — dedup + sort by year/first-author.
- [ ] `src/artifacts/xlsx.ts` — `exceljs` workbook with Papers / Sections / Stats sheets per `01 §4.9`.
- [ ] `templates/report.typ` — Typst template; install `typst` on the box; `src/artifacts/pdf.ts` invokes the CLI.
- [ ] Routes: `GET /searches/:id/report.pdf`, `papers.xlsx`, `references.bib`, `report.md`.
- [ ] Lazy generation + on-disk cache keyed by `search_id`.
- [ ] Emit `artifact` events to the SSE stream when each is ready (`01 §4.9`).
- [ ] `ArtifactsToolbar` enables buttons progressively.

**Acceptance:** all four artifacts download cleanly for a completed run, PDF typography reads as academic, XLSX opens without warnings in Excel + LibreOffice.

---

## Phase 9 — MCP adapter 🟡 ⏱ 2–3 days

Per `01 §7` and `02 §2 mcp/`.

- [ ] `src/mcp/server.ts` — `@modelcontextprotocol/sdk` server bootstrap with both stdio + streamable HTTP transports.
- [ ] `src/mcp/tools/findPapers.ts` — direct passthrough to `POST /search` on the existing backend (`01 §7.2`).
- [ ] `src/mcp/tools/litSearch.ts` — wraps `runAgent`, maps `StreamEvent`s to MCP progress notifications (`01 §7.4`).
- [ ] `src/mcp/resources.ts` — `agenticsearch://searches/{id}/*` + `agenticsearch://papers/{handle}/*` resolvers (`01 §7.6`).
- [ ] `src/mcp/prompts.ts` — `lit_review`, `find_referees`, `journal_scan` templates (`01 §7.7`).
- [ ] Bearer-token auth on the HTTP transport; stdio bypasses (`01 §7.9`).
- [ ] Per-key rate limits per `01 §7.9`.
- [ ] `skip_clarify` default-true behaviour with `needs_clarification` surfacing (`01 §7.3`).
- [ ] CSV output for `lit_search` per the `01 §7.5` columns.

**Acceptance:** Claude Code with the new MCP server config gets a working `lit_search` call returning synthesis + CSV + BibTeX; `find_papers` returns top-K rows under 1s.

---

## Phase 10 — Auth, rate limits, deploy 🟡 ⏱ 2 days

- [ ] API key issuance flow on the Hono side (reuse the existing backend key flow if there is one).
- [ ] Per-IP rate limit on web `POST /chat` (web doesn't need keys).
- [ ] Concurrency limit: 1 active `lit_search` per key.
- [ ] systemd unit + sandbox slice with the `01 §3.5` flags.
- [ ] Caddy config for `agenticsearch.eduard-bruell.de` (TLS + reverse proxy to the Hono app, including `/mcp`).
- [ ] Healthcheck: `GET /healthz` returns DB-copy age + queue depth.

**Acceptance:** the public URL serves the landing page over TLS; an external Claude Code can connect to `https://agenticsearch.eduard-bruell.de/mcp` with a bearer token.

---

## Phase 11 — Old R MCP server retirement 🟢 ⏱ ½ day, scheduled

Per `01 §7.10`.

- [ ] Run the new MCP server in parallel with `backend/R/mcp_server.R` for **one week**.
- [ ] Switch Eddy's Claude Code config to the new endpoint.
- [ ] After a clean week, delete `backend/R/mcp_server.R` and `run_mcp_server*.R`.

**Acceptance:** old MCP service is deleted; nothing in the codebase references it.

---

## Phase 12 — Polish & post-launch (continuous)

Things that don't gate launch but should land soon after.

- [ ] **History reveal** in the sidebar (`03 §10.3`), with storage budget enforcement.
- [ ] **Share links** = same `/c/<id>` URL, read-only for visitors without the search owner key.
- [ ] **Dismissable banner** on the existing `frontend/` advertising "Detective mode" (`03 §10.5`).
- [ ] **Detective meerkat artwork** ships (Eddy, manual).
- [ ] **Paper-upload feature** (`03 §7.1`) — revisit once cost picture is stable.
- [ ] **DOI column on `articles`** (`01 §4.4`, deferred) — revisit when another initiative wants it anyway.
- [ ] Adversarial-script corpus growth: every novel rejection in prod auto-feeds the `tests/ast/bad/` corpus.
- [x] Iterative model-level multi-script runs (search → expand via citations → re-search), capped at 3 rounds (`01 §9.5`) — **designed** as the multistage feature in `07_multistage.md` (2026-06-06); see Phase 14 below for the build plan. Single-script verb chaining (find → resolve-versions → rank-by-stats; chained ZEW example in `04 §2.4` / `examples.ts`) remains the cheaper default; multistage is the escape hatch for strategies unknowable until results return.
- [ ] German-language synthesis path (`04 §10.3`).

---

## Phase 13 — Blocking clarifier + one-shot toggle 🟡 (design done, build pending)

Full design in [`06_clarifier.md`](./06_clarifier.md); build order is `06 §10`. The current clarify
stage is cosmetic (asks rarely, never blocks, discards the answer). This phase makes it a real
pause/resume round-trip with a one-shot opt-out.

- [ ] **Wire + types**: `clarify` stream event, `skipClarify` start-body field, `awaiting_clarification` status, `clarify_question/answer` columns + `SearchDb` methods. (`06 §4–5`)
- [ ] **Pipeline split**: `runAgent` → `runClarifyPhase` + `runSearchPhase`; pause path persists and returns without `done`. (`06 §3`)
- [ ] **Reply endpoint**: `POST /chat/:id/reply`; resumes `runSearchPhase` on the same bus. (`06 §4.2`)
- [ ] **SSE pause semantics**: `bus.isDone` false while awaiting; `clarify` event replays on reconnect. (`06 §3`)
- [ ] **Writer injection**: `<clarification>` block appended to the writer user message. (`06 §5–6`)
- [ ] **Clarifier prompt**: soften proceed-bias when blocking is on; add ask-worthy exemplars. (`06 §6`)
- [ ] **Frontend**: one-shot checkbox, interactive `ClarifierBubble`, reducer `clarify`/`waiting` handling, stepper "waiting" state. (`06 §7`)
- [ ] **Expiry sweeper**: stale `awaiting_clarification` → error after 24h. (`06 §9`)

**Acceptance:** see `06 §10` — ambiguous brief pauses for input with the box unchecked and the
answer changes the resulting script; flows straight through with the box checked; reload-during-pause
restores the input; MCP behaviour unchanged.

---

## Phase 14 — Multistage (results-aware re-running) 🟡 (design done, build pending)

Full design in [`07_multistage.md`](./07_multistage.md); build order is `07 §11`. Today the pipeline
runs one script and synthesises whatever comes back. This phase adds a bounded loop that lets the
agent observe its own results and revise strategy when a pass underperforms (the ZEW
"newest-WPs-aren't-published-yet" failure is the motivating case). Single-script verb chaining stays
the cheaper default; the loop is the escape hatch for strategies unknowable until data returns.

- [ ] **Result summary + flags**: pure fn over `ExecuteResult` → sections/counts/sample + deterministic flags (`all_empty`, `headline_empty`, `thin`, `no_new`). (`07 §3`)
- [ ] **Assessor stage**: cached prompt + structured `{verdict, reason, directive?, mode}`; bias to `adequate`; short-circuit on empty flags. (`07 §3`)
- [ ] **Loop in `runAgent`**: wrap write→validate→execute→assess; cross-round accumulation + dedup; caps (`MAX_ROUNDS=3`) + degenerate-stop; synthesise once. (`07 §2,4,5`)
- [ ] **Writer feedback channel**: `<previous_run>` + `<revision mode>` per-call blocks, distinct from the validation-retry `<rejection>` path. (`07 §6`)
- [ ] **Wire + persistence**: `revise` event; optional `round` field on stage events; optional `rounds_run` column. (`07 §7`)
- [ ] **Frontend**: re-entrant stepper, "refining" sub-state, accumulating results, one-shot pin (`MAX_ROUNDS=1`). (`07 §8`)
- [ ] **Eval**: multi-round eyeball view; wire the ZEW brief as the canonical acceptance test. (`07 §12`)

**Acceptance:** see `07 §12` — with the *naive* (no-domain-hint) ZEW prompt and multistage on, round 1
returns an empty published section, the assessor revises (mode `replace`, names the recency pitfall),
round 2 returns a non-empty tier-led ranking, and synthesis runs once over the accumulated set. Easy
queries finish in one round (assessor `adequate`), adding only a single cheap assessor call.

Depends on nothing new; reuses `executeScript`, `writeScript`, the searches table, and the SSE bus.
Independent of Phase 13 (composes with it: a clarified brief feeds every revise round).

---

## Cross-cutting risks to watch

| Risk | Surfaces in | Mitigation |
|---|---|---|
| OpenRouter caching turns out flaky for the chosen model | Phase 5 | Telemetry-first benchmark; fall back to Haiku 4.5 if cache-hit < 50% |
| Cold-start Rscript boot dominates latency | Phase 3 | Pool of long-lived R workers via `callr` (deferred until measured) |
| AST allowlist rejects a script the model can't recover from | Phase 4 | Rejection hints (`04 §6`) + benchmark validity rate; widen allowlist surgically when justified |
| Typst typography output not academic enough | Phase 8 | Fallback to pandoc + LaTeX class; decided after seeing real output |
| DB copy race during weekly update | Phase 1 / Phase 3 | `update_repec.R` writes to a temp path then atomic-renames into the read-only path; sandbox connection retries once on `database is locked` |
| Per-query cost exceeds target | Phase 5 | Hard ceiling at $0.05 median; if missed, shrink the cached few-shots before considering more expensive models |

---

## Dependency graph (summary)

```
0. Scaffold
   ↓
1. R sandbox  ──┬→ 2. AST allowlist  ──┐
                │                       ↓
                └→ 3. TS runner  ────→ 4. LLM + writer  →  5. Benchmark / model lock
                                                              ↓
                                                          6. runAgent + SSE  ──┬→ 7. Frontend  ─→ 8. Artifacts
                                                                                │
                                                                                └→ 9. MCP  ─→ 10. Deploy  ─→ 11. Retire old MCP
                                                                                                                ↓
                                                                                                            12. Polish (continuous)
```

Phases 7 and 9 can run in parallel once Phase 6 is far enough along to expose `runAgent`. Phase 5 is a gate; nothing downstream commits until model picks are signed off.
