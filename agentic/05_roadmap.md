# Agentic Search — Roadmap (Note 5)

**Companion to:** `00_overview.md`, `01_design.md`, `02_implementation_plan.md`, `03_interface.md`, `04_prompts.md`.
**Scope:** the multi-phase plan of attack — what gets built, in what order, against which acceptance criteria, with which dependencies. Every task here resolves back to a section in one of the other four docs; nothing new is decided in this file.

The phases are sequential by **default** but several pieces can be parallelised once the R sandbox (Phase 1) is solid. Phase tags below show this explicitly.

Legend: 🟢 trivial · 🟡 medium · 🔴 hard or risky · ⏱ rough effort · ⚠ blocker for downstream phase.

---

## Phase 0 — Project scaffolding 🟡 ⏱ ½ day

Set up the empty repo skeleton so every later phase has somewhere to land code.

- [ ] Create `agentic/` directory tree per `02 §1` (`agentic_backend/`, `agentic_frontend/`, `r/`).
- [ ] Add root-level `pnpm-workspace.yaml` (or skip and use a single package per app — decide once).
- [ ] `agentic_backend/`: `package.json`, `tsconfig.json`, `tsx` watch script, Hono "hello world" on `:8001`.
- [ ] `agentic_frontend/`: `astro create` template, Tailwind set up with the inherited palette (CSS variables only — concrete tokens land in Phase 6 after we read them out of the existing `frontend/`).
- [ ] `agentic/r/eddysearch.sandbox/`: bare `DESCRIPTION`, `NAMESPACE`, empty `R/`, `devtools::load_all()` works.
- [ ] Root `agentic/README.md` pointing at `00_overview.md` and the four design docs.
- [ ] `.gitignore` covering `node_modules/`, `dist/`, `.astro/`, `data/`, R `.Rcheck/`.

**Acceptance:** `pnpm dev` boots Hono on `:8001`; `pnpm --filter agentic_frontend dev` boots Astro on `:4322`; `devtools::load_all("agentic/r/eddysearch.sandbox")` exits clean.

---

## Phase 1 — R sandbox foundation ⚠ blocks 2–4 · 🔴 ⏱ 3–5 days

The `eddysearch.sandbox` R package is the heart of the design. Until it exists, nothing else can be tested end-to-end.

### 1.1 Data verbs (`01 §3.2`)

- [ ] `connect_db()` — opens the read-only copy of the latest updated DuckDB with all hardening pragmas applied (`01 §3.4`). Single connection per process.
- [ ] `semantic_search(query, max_k, min_year, journal_filter, journal_name)` — wraps the existing `eddyspapersbackend::semantic_search` semantics, returns a tibble with the documented columns.
- [ ] `sql_query(sql, params = list())` — runs `SELECT_NODE`/`SET_OPERATION_NODE` only after DuckDB parse-tree validation (`01 §3.4`), auto-injects `LIMIT 5000` when absent, sets `statement_timeout = 15s`.
- [ ] `cites(handle, limit = 50)`, `citedby(handle, limit = 50)` — joins against `cit_internal`.
- [ ] `handle_stats(handles)` — read from `handle_stats` table.
- [ ] `versions(handle)` — from `versions` table.
- [ ] `bib_for(handles)` — flat tibble of `bib_tex` strings.
- [ ] `journals()`, `categories()` — reference tibbles for discovery.
- [ ] `paper_url(handle)` — two-tier resolver: `articles.url` then IDEAS-from-handle fallback (`01 §4.4`).

### 1.2 Output verbs + FD-3 event writer (`01 §3.2`, `§4.5`, `§4.10`)

- [ ] `emit_event(list)` — writes one JSON line to FD 3.
- [ ] `emit_section(title, df, n = 25, note = NULL)` — buffers a labelled section; resolves new handles via in-process dedup set; emits a `paper` event per new handle then the `section` event.
- [ ] `emit_note(markdown)` — free-form commentary.
- [ ] `emit_bibtex(handles)` — accumulates handles, emits the final `bibtex` event.
- [ ] `emit_progress(label, current = NULL, total = NULL)` — exposed for model use but rarely needed.
- [ ] Internal wrapping of every data verb to emit start/end `progress` events automatically (`01 §4.5` example).

### 1.3 Helpers (`01 §3.2`)

- [ ] `fmt_row(df, i)` — single-row formatter, mirrors the lit-search `fmt_results` row shape.
- [ ] Default `format_results()` — used if the model doesn't write its own.

### 1.4 Tests

- [ ] `testthat` suite: every verb on a small fixture DuckDB (committed to `agentic/r/eddysearch.sandbox/inst/testdata/`).
- [ ] FD-3 capture test: run a script via `Rscript`, parse the emitted JSON line stream, assert event ordering and `paper`-event dedup.
- [ ] SQL parse-tree validator: golden-file tests for legal/illegal SQL (`01 §3.4`).

**Acceptance:** a hand-written script that mirrors one of the lit-search Mode-A examples produces a complete event stream when run via `Rscript --vanilla` against the real DB copy.

---

## Phase 2 — AST allowlist (`check.R`) ⚠ blocks 5 · 🔴 ⏱ 2–3 days

Per `01 §3.3`.

- [ ] `agentic/r/check.R`: parse user script, walk AST, classify every node.
- [ ] Allowlist constants: base R glue, dplyr, stringr, tidyr, purrr, and the `eddysearch.sandbox` exports. Generated from `01 §3.3` lists.
- [ ] Hard-rejected calls list with informative error messages (`04 §6`).
- [ ] `<<-`, `:::`, `::` (except `magrittr::%>%`), `do.call` with non-literal, `assign`/`get` rejected outright.
- [ ] String-literal scan for `https?://`, absolute paths outside `/tmp/sandbox-out/`, suspicious shell metacharacters — emit warnings, not auto-rejects (SQL strings legitimately contain `;`/`&`).
- [ ] Returns `{ok: TRUE}` or `{ok: FALSE, reason, offending_node, hint}` JSON to stdout.
- [ ] Rejection hints follow the `04 §6` discipline (name the rule, point at the fragment, suggest the legal alternative).

### 2.1 Test corpora

- [ ] `tests/ast/good/` — every real lit-search script Eddy has run, lightly adapted to the `emit_*` API. **All must validate.**
- [ ] `tests/ast/bad/` — adversarial scripts (`library()` calls, `system()`, `eval(parse())`, `do.call("system", ...)`, raw `DBI::dbConnect`, `cat` to file, etc.). **All must reject with a non-empty `hint`.**
- [ ] CI runs both corpora on every push.

**Acceptance:** every good-corpus script validates; every bad-corpus script is rejected with a hint that suggests the legal alternative; a new bad example added in <5 min by editing the corpus.

---

## Phase 3 — TS sandbox runner ⚠ blocks 5 · 🟡 ⏱ 2 days

Per `02 §2 sandbox/` and `01 §3.5`.

- [ ] `bin/run-sandbox.sh` — `systemd-run --scope --uid=eddysandbox` with all the hardening flags from `01 §3.5`.
- [ ] `bin/check.sh` — `Rscript --vanilla check.R <script>`.
- [ ] `src/sandbox/runSandbox.ts` — spawn the script via `bin/run-sandbox.sh`, wire FD 3 to a line reader, parse one JSON event per line, push to an `onEvent` callback. Returns `{result, events, exitCode, stdout, stderr}`.
- [ ] `src/sandbox/checkScript.ts` — spawn `bin/check.sh`, parse JSON, return typed result.
- [ ] `src/sandbox/events.ts` — type guards + `seq` assignment.
- [ ] `src/sandbox/snapshot.ts` — resolve current copy-of-DB path; warn if older than N days.

### 3.1 Tests

- [ ] End-to-end "TS spawns R, gets events back" test against the same script used in Phase 1's acceptance.
- [ ] Wall-clock timeout test: a deliberate `Sys.sleep(60)` script is killed at 30s.
- [ ] Memory cap test: a script that allocates 2 GB is killed by `MemoryMax=1G`.
- [ ] FD-3 truncation test: a script that emits >2 MB of events triggers the per-row truncation gracefully.

**Acceptance:** the same hand-written script from Phase 1 runs via TS, the orchestrator sees the same event sequence, ulimits are demonstrably enforced.

---

## Phase 4 — LLM layer + writer stage 🟡 ⏱ 3 days

Per `02 §2.1` and `04 §1–§3`.

### 4.1 OpenRouter client (`02 §2.1`)

- [ ] `src/llm/client.ts`: `createOpenRouter({ apiKey })`.
- [ ] `src/llm/stream.ts`: `streamText` helper with cache_control passthrough.
- [ ] `src/llm/structured.ts`: `generateObject` wrapper with zod schemas.
- [ ] Per-call logging of `prompt_tokens_details.cached_tokens` to a dev log file (`04 §1`).

### 4.2 Cached prompt corpus (`04 §2`)

- [ ] `src/prompts/apiReference.ts` — generated from the verb signatures in `eddysearch.sandbox` (consider scripting this from the package's roxygen output).
- [ ] `src/prompts/journalCategories.ts` — verbatim from `lit-search/SKILL.md`.
- [ ] `src/prompts/semanticQueryGuide.ts` — verbatim from `lit-search/SKILL.md`.
- [ ] `src/prompts/examples.ts` — three worked scripts (`04 §2.4`); each adapted to use `emit_*` rather than `cat`/`writeLines`.
- [ ] `src/prompts/writerRules.ts` — hard rules + their "why" lines (`04 §2.5`).
- [ ] Assembly helper that emits a single content block with `providerOptions.openrouter.cacheControl`.

### 4.3 Writer stage (`02 §2`, `04 §3`)

- [ ] `src/agent/stages/writeScript.ts` — `generateObject` against `{script: string}` schema; injects `<brief>`, `<filters>`, `<db_snapshot>` blocks (`04 §3`).
- [ ] Retry path: appends `<previous_attempt>` + `<rejection>` blocks; switches model to `writerRetry` after two failures.
- [ ] Token telemetry surfaced on every call (cached / total).

### 4.4 Eyeball harness (no UI yet)

- [ ] CLI tool `pnpm tsx scripts/eyeball.ts <brief>` — runs writer → validator → sandbox → prints the event log. No synthesiser yet.
- [ ] Replay 20 representative briefs from Eddy's lit-search history; inspect manually.

**Acceptance:** 20 briefs end-to-end, ≥80% produce a script that validates on the first try, ≥95% validate within one retry. Cache-hit ratio on writer stage ≥70% in steady state.

---

## Phase 5 — Cost benchmark & model lock-in 🔴 ⏱ 2 days

Gate before committing to the cheap-model defaults (`02 §2.1`).

- [ ] Seed corpus: 50 representative briefs (mix of topic searches, journal scans, editor targeting, author lookups) — capture them as `tests/benchmarks/briefs.jsonl`.
- [ ] Harness: run each brief through writer + validator + sandbox + synthesiser (Phase 4 + a minimal Phase 6 synth stage spun up early).
- [ ] Per-candidate model run on each stage:
  - writer: `qwen/qwen3-coder-flash`, `deepseek/deepseek-v3.2`, `qwen/qwen3-coder-plus`, Haiku 4.5
  - synth: same shortlist + Gemini Flash
- [ ] Metrics per candidate: (a) script-validity rate after one retry, (b) synthesis quality judged blind by Eddy on a 1-5 rubric, (c) wall-clock per stage, (d) per-query cost USD, (e) **verified cache-hit ratio** from telemetry.
- [ ] Output: a `benchmark_report.md` with the table + Eddy's call on defaults + fallbacks.

**Acceptance:** Eddy signs off on the default + fallback model picks for each stage, with documented per-query cost ≤ $0.02 (target) or ≤ $0.05 (ceiling) on the median brief.

---

## Phase 6 — Full pipeline (`runAgent`) + SSE 🟡 ⏱ 3 days

Per `02 §2.2` and `01 §4`.

### 6.1 Stages

- [ ] `src/agent/stages/clarify.ts` — single optional turn, structured output per `04 §4.2`.
- [ ] `src/agent/stages/validate.ts` — wraps `checkScript.ts`, surfaces typed result.
- [ ] `src/agent/stages/execute.ts` — wraps `runSandbox.ts`, translates R-side FD-3 events into wire `StreamEvent`s.
- [ ] `src/agent/stages/synthesize.ts` — streams markdown using the synthesiser cached prompt (`04 §5`); injects `<brief>`, `<script>`, `<sections>`, `<papers>`, `<bibtex>` blocks.
- [ ] `src/agent/runAgent.ts` — orchestrates all five stages, emits the full `StreamEvent` taxonomy from `01 §4.3`, assigns `seq`.
- [ ] `src/agent/cache.ts` — `search_id` hash over `{brief, modes, year_range, categories, must_include, db_snapshot_date}`; memoise in the `searches` cache table.
- [ ] `src/db/searches.ts` — tiny read-write DuckDB at `data/agentic/searches.duckdb`.

### 6.2 Transport

- [ ] `src/stream/bus.ts` — in-memory pub/sub keyed by `search_id`, ring buffer of last N events for replay.
- [ ] `src/stream/sse.ts` — Hono SSE helper, heartbeat every 15s, `Last-Event-ID` replay.
- [ ] `src/routes/chat.ts` — `POST /chat` kicks off a run, returns `{id}`.
- [ ] `src/routes/stream.ts` — `GET /chat/:id/stream` subscribes to the bus.
- [ ] `src/routes/searches.ts` — `GET /searches/:id` returns the cached structured payload.

### 6.3 Event recording for frontend dev

- [ ] CLI: `pnpm tsx scripts/record-events.ts <brief> > fixture.jsonl` — drives a real run and dumps every event for the frontend to replay against. (`02 §7` step 6.)

**Acceptance:** running `POST /chat` then subscribing to the SSE stream from `curl` reproduces a full event sequence for a representative brief; the recorded fixture is replayable.

---

## Phase 7 — Web frontend (`agentic_frontend/`) 🟡 ⏱ 4–5 days

Per `03_interface.md` end-to-end. **Can start in parallel with Phase 6** as soon as the event fixture from §6.3 exists.

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

- [ ] Landing state: centered logo + `TASK` panel + category pills + advanced disclosure + `Run` button + DB footer.
- [ ] Working/results state: collapsed sidebar with logo + TASK textarea (frozen during run) + category pills + advanced + `Run` + DB footer + `← Semantic mode` link.
- [ ] Right pane reading order (`03 §3.2`): `StageStepper` → `ProgressLine` → `ScriptPanel` (collapsed, labelled "Show database search script") → `ClarifierBubble` (inline if needed) → `SynthesisPanel` → `ArtifactsToolbar` → `EVIDENCE` divider → collapsed `SectionCard` list.

### 7.4 Components (`03 §11`)

- [ ] `chat/StageStepper.jsx`, `ProgressLine.jsx`, `ScriptPanel.jsx`, `ClarifierBubble.jsx`.
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
- [ ] Iterative-script runs (search → expand via citations → re-search), capped at 3 rounds (`01 §9.5`).
- [ ] German-language synthesis path (`04 §10.3`).

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
