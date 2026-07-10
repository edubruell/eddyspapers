# PLAN — One Hono API, an MCP surface, and skill replacement

_Drafted 2026-07-10. This plan integrates three asks into one programme: (1) an MCP server that can
fire agentic searches and replace most of the local `lit-search`/`lit-check` skills (now parked in
`localwip/`), (2) new keyword-search endpoints plus simple MCP tools (keyword, semantic, people) with
enough context tooling for a consuming model, and (3) the long-planned backend split — Plumber goes
away, a general Hono API serves every product, and the R `eddyspapersbackend` package becomes
pipeline-only._

The MCP design in `agentic/01_design.md` §7 remains the base for the agentic tool; this plan extends
it (more tools than the original "two doors", plus auth concretisation) — §7 gets updated to match
(see §10, "Doc updates").

---

## 1. Where we are

- **Three products, two web stacks.** R/Plumber on `:8000` serves classic search + EconPeople
  (`backend/inst/plumber/api.R`); Node/Hono on `:8001` serves agentic search
  (`agentic/agentic_backend/`). nginx fronts three subdomains and injects `X-API-Key` server-side
  (`ops_notes/SERVER_SETUP.md`).
- **The old R MCP server is already retired** on prod (2026-06-11, `ops_notes/PRE_DEPLOY_TODO.md` #3).
  `backend/R/mcp_server.R` + `run_mcp_server*.R` are dead code awaiting deletion. The replacement was
  always planned as a Node adapter (roadmap v0.4.0 note, `agentic/05_roadmap.md` Phase 9/11 — deferred
  until now).
- **The skills to replace** (`localwip/lit-search/SKILL.md`, `localwip/lit-check/SKILL.md`) work by
  generating local R scripts against a local DuckDB + local Ollama. Their capabilities:
  - *lit-search:* multi-section searches — semantic (`semantic_search()`), keyword
    (`LOWER(title) LIKE` chains with category/year filters), journal scans, author lookups, working-paper
    sweeps — then BibTeX export, a `found_handles.csv` dedup log, and an LLM-written synthesis.
  - *lit-check:* bibliography verification via three-tier matching (handle → year+author+title-keyword
    → year±1+author+first-two-words), then citation stats (`handle_stats`) and metadata-mismatch flags.
- **No keyword-only endpoint exists.** The Plumber `/search` is embedding-first; `title_keyword` /
  `author_keyword` are only post-filters on a semantic result. Keyword search currently lives *only*
  inside skill-generated SQL and the agentic sandbox's `sql_query()`.
- **Hono already reads DuckDB directly** (`@duckdb/node-api` against the `articles_agentic.duckdb`
  snapshot) and already has: a password gate (`src/middleware/auth.ts` — bearer or `x-agentic-key`),
  a persistent run store (`src/db/searches.ts`), `@modelcontextprotocol/sdk` in `package.json`
  (unwired), and an empty `src/mcp/tools/` directory waiting for this work.

## 2. Target architecture

```
                          ┌─ nginx: econpapers.eduard-bruell.de      /api/ ─┐
                          ├─ nginx: econpeople.eduard-bruell.de      /api/ ─┤
                          ├─ nginx: agenticsearch.eduard-bruell.de   /api/ ─┤
                          └─ nginx: agenticsearch.eduard-bruell.de   /mcp  ─┤
                                                                            ▼
   R pipeline (cron)                                        ONE Node/Hono service (:8001)
   update_repec.R                                           ├─ REST: /search /person/* /stats/* …
   sync → parse → embed → cit_* →   articles.duckdb ──────► ├─ REST: /chat /export /searches (agentic)
   person tables → parquet diffs    (read-only snapshot,    ├─ MCP:  streamable HTTP + stdio binary
                                     swap-on-update)        ├─ SSE:  run streams
   eddyspapersbackend = pipeline                            ├─ R sandbox subprocess (lit_search runs)
   only; no Plumber, no HTTP        appdata.duckdb ◄──────  ├─ Ollama :11434 (query embeddings, from Node)
                                    (read-write, Hono-owned:└─ auth: API-key registry + rate limits
                                     saved searches, logs,
                                     api_keys, agentic runs)
```

Three structural moves:

1. **Query embeddings move to Node.** `POST http://127.0.0.1:11434/api/embed` with
   `mxbai-embed-large` is a plain HTTP call — no R needed at query time. Side benefit already flagged
   in the Window-2 deploy log: once the sandbox no longer needs Ollama for `semantic_search()` (Node
   passes the query vector in), the R sandbox can be fully network-isolated (`01_design.md` §3.5
   follow-up).
2. **Corpus/app-data split.** The corpus DB (`articles.duckdb` snapshot) is opened **read-only** by
   Hono and swapped after each pipeline run (the `articles_agentic.duckdb` pattern, generalised).
   User-generated tables (`saved_searches`, `search_logs`, `person_search_logs`,
   `saved_person_searches`, agentic `searches`, new `api_keys`) move to a small Hono-owned
   `appdata.duckdb`. This kills the standing hazard from `PRE_DEPLOY_TODO.md` #1 (user data living
   inside the regen-able 12G corpus file) and removes the stop-the-API dance for most deploys.
3. **One service.** The agentic backend grows into the general server (keep `:8001`; rename the
   systemd unit when convenient). Plumber is retired; frontends keep calling same-origin `/api` with
   unchanged routes, so the cutover is an nginx `proxy_pass` repoint — **zero frontend changes**.

## 3. Workstream A — Hono API consolidation (the backend split)

### A1. DB layer
- `src/db/corpus.ts`: read-only connection pool to the snapshot; `INSTALL/LOAD vss` on open; verify
  HNSW index use from `@duckdb/node-api` (validation task — read-only + VSS is exactly what the R
  sandbox already does, so this is expected to work, but prove it first).
- `src/db/appdata.ts`: read-write `appdata.duckdb`; migration script exports the existing
  user-generated tables out of prod `articles.duckdb` once, at cutover.
- Snapshot swap: pipeline writes `articles.duckdb.new` → atomic rename → Hono watches mtime (or a
  `POST /admin/reload` behind an admin key) and reopens. Replaces the manual
  `cp articles.duckdb articles_agentic.duckdb` step.

### A2. Route parity (port from `backend/inst/plumber/api.R`)

| Plumber route | Port to Hono | Notes |
|---|---|---|
| `POST /search` | yes | embedding via Node→Ollama; same response shape (incl. `similarity_score`) |
| `POST /search/save`, `GET /search/{hash}` | yes | xxhash64-style deterministic hash retained (`saved_searches` moves to appdata) |
| `GET /versions`, `/cites`, `/citedby`, `/citationcounts`, `/handlestats` | yes | straight SQL ports |
| `GET /stats/total|journals|categories|last_updated|searches`, `/dailylogs` | yes | `last_updated` reads `db_metadata` |
| `POST /person/search` + all `/person/*` | yes | port the two-stage CTE — the agentic sandbox's `person_search` verb (`agentic/r/eddysearch.sandbox`) is already the read-only CTE re-implementation; translate that, not the Plumber temp-table version |
| `POST /admin/apply_diff` | **no** | diff application stays a pipeline concern (`deploy_diffs.sh` → `server_apply_diff.R`); not an HTTP surface |

Search logging (`search_logs`, `person_search_logs`) is ported with the same columns so the stats
endpoints keep working across the cutover.

### A3. Cutover & R-package demotion
- Dual-run window: Hono routes live on `:8001` while Plumber keeps `:8000`; diff responses on a
  recorded query set (the `search_logs` corpus gives realistic queries).
- nginx repoint (classic + econpeople `/api/` → `:8001`), keep the server-side key injection.
- Then strip `backend/`: delete `inst/plumber/`, `R/api.R` HTTP parts, `R/mcp_server.R`,
  `run_api.R`, `run_mcp_server*.R`. `eddyspapersbackend` keeps sync/parse/embed/database/persons
  build code only. Bind nothing on `:8000`; close the "`:8000` reachable from the internet" hole
  (`PRE_DEPLOY_TODO.md`) for free.

## 4. Workstream B — new search endpoints (Hono-native, never built in Plumber)

### B1. `POST /papers/keyword`
The keyword capability the skills implement by hand, as a first-class endpoint:
```jsonc
{
  "keywords": ["minimum wage", "monopsony"],   // OR within list
  "fields": ["title"],                          // subset of title|abstract|authors, default ["title"]
  "match": "any",                               // any|all across keywords
  "min_year": 2005, "max_year": null,
  "categories": ["Top 5 Journals","Top Field Journals (A)"],
  "journal_name": null,                         // substring, comma-separable like /search
  "order_by": "year",                           // year|citations (joins handle_stats)
  "limit": 100, "offset": 0
}
```
Implementation v1 = parameterised `LOWER(col) LIKE '%kw%'` chains (exact parity with skill behaviour,
no new index). v2 (optional, later): DuckDB FTS extension index (BM25, stemming) built by the R
pipeline during `update_repec.R` — decide only if LIKE relevance proves insufficient in real use.
Response: `PaperResult[]` (no similarity fields) + `total` for pagination.

### B2. `POST /papers/verify`
lit-check's three-tier matcher as a batch endpoint:
```jsonc
{ "entries": [ { "cite_key": "smith2020", "handle": null,
                 "author_lastnames": "Smith; Jones", "year": 2020,
                 "title": "…", "journal": "…" } ] }
```
Per entry: `status` (`handle_match|fuzzy_match|loose_match|not_found`), the matched paper row,
`stats` (`citation_percentile`, `total_citations`, `citations_per_year` from `handle_stats`), and
`mismatches[]` (year off by >1, journal disagreement). Port the tier logic verbatim from
`localwip/lit-check/SKILL.md` (title-keyword extraction incl. the stopword guard).

### B3. `GET /corpus/guide`
The "context tooling" endpoint (also exposed via MCP, §C3): snapshot date, total articles, the seven
categories with counts and example journals, journal list per category (top-N by article count),
person-corpus counts, and the semantic-query-writing guidance (the "3–6 sentences of abstract-style
prose" doctrine from the skill). Static-ish JSON assembled from `journals` + counts + a maintained
text block; cache in-process.

## 5. Workstream C — the MCP server

Thin transport adapter inside the same Hono service (per `01_design.md` §7.1): **streamable HTTP at
`agenticsearch.eduard-bruell.de/mcp`** (default) + a **stdio entry point** (`dist/mcp-stdio.js`) for
local spawning. Tools call the same internal service functions as the REST routes — no HTTP
self-calls, no duplicated logic.

### C1. Tool surface
§7.2's "two doors" predates the requirement that simple searches also work over MCP without the fat
pipeline. New surface — six tools, still small:

| Tool | Cost class | Maps to | Replaces (in the skills) |
|---|---|---|---|
| `lit_search` | LLM + sandbox (~30s+) | `runAgent` (skip_clarify=true default, §7.3 semantics) | the whole lit-search generate-script-and-synthesise loop |
| `find_papers` | embed-only | `/search` internals | `semantic_search()` sections |
| `keyword_search` | SQL-only | `/papers/keyword` | the `LIKE`-chain KW sections |
| `find_people` | embed + rollup | `/person/search` internals | "active authors" mode (better than the skill ever was) |
| `verify_references` | SQL-only | `/papers/verify` (batch) | lit-check's entire R script |
| `corpus_context` | free | `/corpus/guide` | the skill file's embedded corpus knowledge |

`lit_search` keeps everything §7 already designed: progress-notification mapping (§7.4), the
three-artifact bundle + `suggested_paths` (§7.5), `search_id` caching (§7.8), `needs_clarification`
as a structured non-error result — **no blocking prompts over MCP, ever**.

### C2. Resources & prompts (unchanged from §7.5–7.7)
- `agenticsearch://searches/{id}[/script|/bibtex|/papers|/sections/{sid}]`
- `agenticsearch://papers/{handle}[/citedby|/cites]` — subsumes versions/citations/stats tools
- Prompts: `lit_review`, `find_referees`, `journal_scan`.

### C3. Context for the consuming model
Three layers, because client support varies:
1. **Server `instructions`** (MCP initialize): one paragraph — what the corpus is (~455k paper
   RePEc/econ corpus + 88k registered authors), when to use `lit_search` vs the cheap tools, and the
   semantic-query prose rule.
2. **Tool descriptions** carry the per-tool doctrine (e.g. `find_papers`: "write the query as 3–6
   sentences of abstract-style prose describing mechanism, method, context — not topic labels";
   `keyword_search`: "use for exhaustive term sweeps and known-phrase lookups").
3. **`corpus_context` tool** (and mirrored `corpus://guide` resource) for on-demand detail:
   categories + counts, journal names (so models stop guessing filter values), snapshot date, person
   scoring modes.

### C4. What stays client-side when the skills shrink
The skills' *filesystem* jobs don't move into MCP: writing `lit_[slug].md`, `results_[slug].bib`,
and maintaining `found_handles.csv` remain the calling agent's work (`suggested_paths` hints at
targets). Rewritten skills become thin orchestration recipes (§8, Workstream E).

## 6. Workstream D — authentication (the API-key question, answered)

**Yes — API keys are the right mechanism, and you can hand them out.** Concretely:

- **MCP over streamable HTTP authenticates with `Authorization: Bearer <key>`.** Developer-tool
  clients all support this: Claude Code (`claude mcp add --transport http eddysearch
  https://agenticsearch.eduard-bruell.de/mcp --header "Authorization: Bearer KEY"`), VS Code, Cursor,
  and raw SDK clients. This is exactly `01_design.md` §7.9 and matches the existing
  `requireAuth` middleware, which already parses Bearer tokens.
- **A "password for an MCP" is just a shared API key** — that's what `AGENTIC_PASSWORD` is today.
  Fine for a small trusted circle (ZEW preview), but per-user keys are strictly better: individual
  rate limits, revocation, and per-key spend attribution for `lit_search` (which costs real model
  tokens). Issue per-person keys; keep one shared "ZEW guest" key only if onboarding friction matters.
- **The one real limitation: claude.ai / Claude Desktop custom connectors and ChatGPT connectors
  don't send custom headers** — remote-connector auth there means **OAuth 2.1** (the MCP spec's
  official HTTP auth, with dynamic client registration). Two answers, pick per audience:
  1. *Now:* target coding agents (Claude Code, IDEs, SDK) with bearer keys. That covers the
     lit-search-skill-replacement use case entirely.
  2. *Later, if consumer chat clients matter:* add an OAuth 2.1 layer (the TS MCP SDK ships
     `ProxyOAuthServerProvider`/router helpers; issued tokens can simply *be* the API keys). A
     separate phase — don't block on it.
  (URL-embedded keys — `/mcp/<key>` — work for header-less clients but leak into logs; avoid unless
  a concrete client forces it.)
- **stdio transport bypasses auth** (§7.9: the key is shell access) — but the hosted stdio variant
  still needs the HTTP key when it proxies to the server; a purely local stdio build talking straight
  to a local DuckDB copy stays keyless.

### D1. Implementation
- `api_keys` table in `appdata.duckdb`: `key_hash` (store SHA-256, never plaintext), `label`,
  `scopes` (`rest`, `mcp`, `lit_search`, `admin`), `rate_limit_overrides`, `created_at`, `revoked_at`.
- Extend `requireAuth` → `requireKey(scope)`: Bearer/`x-api-key` lookup with constant-time compare;
  `AGENTIC_PASSWORD` grandfathered as a legacy key during transition.
- Rate limits (in-process counters keyed by key id, per §7.9): `lit_search` 30/h + 300/day + 1
  concurrent; `find_papers`/`find_people` 600/h; SQL-only tools generous. No per-IP limiting (ZEW
  NATs everything through one IP — established decision).
- Key issuance: a small CLI (`scripts/keys.ts new|revoke|list`) — no admin UI needed.
- nginx keeps injecting the frontend key for the public web apps, unchanged pattern; the injected
  key becomes a row in `api_keys` with `rest` scope.

## 7. Workstream E — replace the local skills

- **`lit-search` skill v2:** shrink from 406 lines of R-script-generation doctrine to a short recipe:
  clarify intent with the user → call `corpus_context` if filter values are needed → either one
  `lit_search` call (default) or composed `find_papers`/`keyword_search`/`find_people` calls for
  surgical searches → write returned `synthesis_md`/`bibtex`/`papers_csv` to the project paths →
  append handles to `found_handles.csv`. No local R, no local DuckDB, no Ollama requirement.
- **`lit-check` skill v2:** extract bib entries from `.bib`/`.tex`/`.md` (the model's job, unchanged)
  → one `verify_references` call → render the report (summary / NOT FOUND / mismatches / verified
  table) → cross-reference `found_handles.csv` locally.
- Keep `localwip/` as the reference corpus until the v2 skills are validated on a real project, then
  archive.

## 8. Phasing

Dependencies: 1 → 2 → {3, 4} → 5 → 6; 4 must land before any key is handed out.

| Phase | Scope | Acceptance |
|---|---|---|
| **1. Search core in Hono** | Ollama embedding from Node; corpus read-only pool + VSS validation; internal service fns for semantic, keyword (B1), verify (B2), person search (CTE port); REST routes `/papers/keyword`, `/papers/verify`, `/corpus/guide` live on `:8001` | parity test: same top-20 vs Plumber `/search` on 25 logged queries; keyword + verify endpoints reproduce skill-script outputs on a real bibliography |
| **2. MCP adapter, cheap tools** | streamable HTTP `/mcp` + stdio entry; tools `find_papers`, `keyword_search`, `find_people`, `verify_references`, `corpus_context`; resources + prompts; server instructions | Claude Code connects via `--header` key config; a fresh session finds a known paper set with zero skill file present |
| **3. `lit_search` over MCP** | wire `runAgent` (skip_clarify default, progress notifications, §7.5 result bundle, `search_id` cache, `needs_clarification` path) | a coding agent gets a synthesis + bib + CSV from one tool call; repeat call hits cache; ambiguous brief returns structured questions, not a hang |
| **4. Keys & limits** | `api_keys` in appdata, `requireKey(scope)`, rate limiter, key CLI, docs for client setup | old password still works; revoked key 401s; `lit_search` limit enforced; keys handed to first two external users |
| **5. Plumber retirement** | port remaining routes (save/load, stats, logs), appdata migration of user tables, dual-run diff, nginx repoint for classic + econpeople, strip HTTP from R package, snapshot-swap in pipeline | all three frontends work unchanged against `:8001`; `:8000` closed; `update_repec.R` ends with an atomic snapshot swap and no API stop for diff deploys |
| **6. Skill v2** | rewrite `lit-search`/`lit-check` against MCP; validate on a live project; archive `localwip/` | one real literature search + one real bib check completed end-to-end with no local R/DB/Ollama |

Phases 1–4 are the user-visible payoff (MCP + keyword search) and deliberately front-loaded;
phase 5 is the consolidation debt-paydown and can trail by weeks without blocking anything.
Every phase gates on the local test rig (§12) **and a fresh-context sub-agent review (§12.4)**;
the Phase 5 cutover additionally follows the backup + rollback runbook in §12.3 — no prod deploy
of the split without a verified backup.

## 9. Risks / validation points

- **`@duckdb/node-api` + VSS/HNSW read-only**: ~~assumed fine~~ **spiked 2026-07-10, works** —
  read-only open + `INSTALL/LOAD vss` + cosine query from Node returns correct results (510ms warm,
  151ms filtered on the 455k corpus). Finding: `idx_hnsw` was built with the default **l2sq** metric,
  so `array_cosine_distance` queries have *never* used it — Plumber full-scans too. Node therefore
  matches prod behaviour as-is. Follow-up (pipeline, not Phase 1): rebuild the index
  `WITH (metric='cosine')` in `create_indices()` (`backend/R/database.R`) to get real HNSW
  acceleration for both stacks; an l2sq probe from Node confirms persisted-index scans work
  read-only. Validation script kept at `agentic_backend/scripts/spike_vss.ts`.
- **Person-search CTE parity**: the sandbox verb already re-implements it read-only; port that, then
  diff rankings against Plumber for a query battery (scoring modes × filters).
- **DuckDB writer/reader coexistence**: appdata is Hono-exclusive (no contention); corpus is
  read-only + swap (no contention). The only remaining lock choreography is the swap rename itself.
- **MCP client variance**: resources/prompts are second-class in some clients — that's why every
  load-bearing capability is also a tool (`corpus_context`) and why context rides in tool
  descriptions.
- **Spend abuse via `lit_search`**: mitigated by scoped keys + per-key limits + 1-concurrent cap
  before any key leaves the house (Phase 4 gates Phase 3's exposure).

## 10. Doc updates required (code and docs stay in sync)

- `agentic/01_design.md` §7: two-doors → six-tool surface (§5 above); §7.9 gains the key-registry
  concretisation; note nginx (not Caddy) while touching it.
- `agentic/05_roadmap.md`: Phase 9 un-defer + rescope to this plan's Phases 2–3; Phase 11 (R MCP
  deletion) folds into Phase 5 here.
- `CLAUDE.md`: "What this project does NOT touch" — `backend/` zero-edits rule is superseded by
  Phase 5; update when Phase 5 starts, not before.
- `econpeople/02_api.md`: note the serving layer moves to Hono (endpoints unchanged).
- `roadmap.md`: v0.4.0 note → point at this PLAN.md.

## 11. Decisions (resolved 2026-07-10)

1. **Keyword search v1 = LIKE-parity.** No FTS index for now; revisit only if real MCP usage shows
   ranking pain. `update_repec.R` stays untouched by Workstream B.
2. **OAuth 2.1 deferred indefinitely.** Bearer API keys are the only MCP auth mechanism; the
   coding-agent audience is fully covered. Revisit only on a concrete claude.ai/ChatGPT connector ask.
3. **Service rename at Phase 5 cutover.** `agentic-api.service` → `eddyspapers-api.service` in the
   same maintenance window that repoints nginx and retires the R unit (which frees the name).
4. **Snapshot swap on pipeline run.** Atomic swap after each `update_repec.R` run; the `search_id`
   cache lives until the swap (correct, since data is unchanged between runs). No nightly rotation —
   update `01_design.md` §7.8's TTL wording accordingly (fold into the §10 doc pass).

## Progress log

**Phase 1 — built 2026-07-10, pending phase-exit review sign-off.** Delivered: `src/db/corpus.ts`
(read-only pool + vss), `src/search/{embed,types,papers,persons,guide}.ts`, routes
`/papers/keyword` + `/papers/verify` + `/corpus/guide` (mounted via a new `src/app.ts` so routes are
testable), fixture builder + 45-test suite (full suite 28 files green), parity harness
(`scripts/parity.ts` + committed battery): **25/25 semantic queries at 20/20 top-20 overlap vs prod
Plumber (max Δsimilarity 8e-5 — no embedding drift), 6/6 person queries ≥9/10 overlap.** Remaining
Phase 1 acceptance item: run `/papers/verify` against a real bibliography from a live project
(needs one of the user's .bib files).

Bugs found & fixed along the way (all pre-existing, surfaced by the harness/fixture work):
1. `agentic/r/eddysearch.sandbox/R/data_verbs.R` — `cites()`/`citedby()` joined mixed-case
   `articles.Handle` against lowercase `cit_internal`, returning **0 rows on every call** since the
   verbs shipped. Fixed with LOWER() joins; needs a sandbox-package reinstall on prod (fold into the
   next deploy).
2. `backend/R/persons.R` — vectorised-`ifelse` recycling made `quality_norm`/`overlap_norm`
   constants: **`quality_weight` never affected econpeople rankings and `blended` mode degenerated
   to `best_match` in prod.** Fixed locally (scalar `if/else`); prod runs the buggy build until the
   next R package deploy, so the parity battery pins `quality_weight: 0` and skips `blended` —
   re-add after that deploy.
3. HNSW index metric mismatch (see §9): semantic search has always full-scanned in prod; rebuild
   `WITH (metric='cosine')` queued as a pipeline follow-up.
4. `tests/db/stats.test.ts` computed "today" in UTC while DuckDB `now()` is local — suite failed
   between midnight and 02:00 CEST. Fixed.

**Phase 2 — built 2026-07-10, phase-exit reviews passed (no blockers).** Delivered the MCP adapter
and the five cheap tools. New: `src/mcp/{server,tools,resources,prompts,instructions}.ts`,
`src/routes/mcp.ts` (streamable-HTTP `/mcp`, wildcard-mounted so `/mcp` and `/mcp/` both route, behind
`requireAuth`), `src/mcp-stdio.ts` (`dist/mcp-stdio.js` stdio binary, auth-bypassed per §7.9,
stderr-only), and `src/search/citations.ts` (read-only ports of the sandbox cites/citedby/handle_stats/
versions verbs, reused by the Phase 5 REST citation routes). `src/search/papers.ts` gained exported
`PAPER_COLS` + `rowToPaper` for reuse. Tool/resource/prompt surface matches §C1/§7.6/§7.7 exactly:
tools `find_papers`, `keyword_search`, `find_people`, `verify_references`, `corpus_context`; resources
`corpus://guide` + `agenticsearch://papers/{handle}[/cites|/citedby]`; prompts `lit_review`,
`find_referees`, `journal_scan`; server `instructions`. Each tool returns both a JSON text block and
`structuredContent` (no `outputSchema` declared — deliberate). `lit_search` stays Phase 3.

Notes from the build:
1. Installed `@modelcontextprotocol/sdk` resolves to **1.29.0** (not the 1.12.1 pinned in
   `package.json`). Its stateless web-standard transport **refuses reuse** ("cannot be reused across
   requests"), so `/mcp` builds a fresh server+transport per request with `enableJsonResponse: true`
   and deterministic teardown after the body is buffered. Registration is cheap (the DuckDB pool is a
   shared singleton); revisit only if HTTP MCP QPS grows.
2. `?limit=N` on the cites/citedby resources (§7.6) is **not wired** — the SDK `ResourceTemplate`
   matcher rejects URIs with an undeclared query string, and `{?limit}` would make the param
   mandatory. Resources return the default cap (50); §7.6 updated to drop `?limit=N`.
3. Test suite: 34 review-added tests (`tests/mcp/{server,edgecases}.test.ts`, `tests/routes/mcp.test.ts`)
   — full suite **426 passed / 4 skipped, 32 files**. Both faces validated end-to-end (HTTP initialize
   over `app.request`; stdio `initialize` handshake returns `serverInfo eddysearch 0.2.0`).
4. Doc pass (§10): `01_design.md` §7.2 (two-doors → six tools), §7.6 (`?limit=N` dropped), §7.8 (TTL
   wording → snapshot-swap, not nightly), §7.9 (Phase-2 shared-password gate + nginx note) updated.

**Phase 3 — built 2026-07-10, phase-exit reviews passed (no implementation blockers).** Wired
`lit_search` — the full agentic pipeline over MCP. New: `src/agent/bundle.ts` (a pure run-events →
§7.5 bundle reducer shared by the tool and the searches resources), `src/mcp/litSearch.ts` (the
`lit_search` tool). Modified: `src/mcp/resources.ts` (+ the `agenticsearch://searches/{id}[/script|
/bibtex|/papers|/sections/{sid}]` run resources), `src/mcp/server.ts` (register `lit_search`),
`instructions.ts` + `prompts.ts` (`lit_review` now drives `lit_search`). The six-tool surface (§C1)
is complete. Acceptance met: one call returns a synthesis + BibTeX + CSV + structured payload; an
identical brief hits the persisted cache without re-running R/LLM; with `skip_clarify=false` an
ambiguous brief returns a non-error `needs_clarification` result (no pause/resume over MCP);
`skip_clarify` defaults **true**.

Notes from the build:
1. The MCP tool reuses the same `computeSearchId` cache + `searches` store + `runAgent` as the web
   `/chat` path — a completed run is rebuilt from its stored events, so the cache, the share-links,
   and the run resources all share one source of truth. MCP-initiated runs persist to the store but
   are not published to the in-memory SSE bus (no web client is watching).
2. Progress notifications (§7.4) stream over stdio and any SSE-mode HTTP path; under the hosted
   streamable-HTTP transport's buffered JSON mode (`enableJsonResponse`) they return with the reply
   rather than live.
3. Review fixes folded in before commit: finalize now mirrors the web `hasDone` guard (never cache a
   truncated run as `done`); the search-section resource decodes `{sid}` (SDK doesn't decode path
   segments); dropped an unused `runHasContent` helper.
4. **Deferred to Phase 4:** the shared cache key (`src/agent/cache.ts`) still omits `must_include`
   and `refine` — widen it with the key registry. Per-key rate limits + single-concurrent
   `lit_search` (§7.9) also land in Phase 4; `/mcp` is behind shared-password `requireAuth` today.
5. Doc pass (§10): `01_design.md` §7.2/§7.4/§7.5/§7.6/§7.8 updated (see FINDINGS.md Phase 3).
6. Tests: 23 review-added tests (`tests/agent/bundle.test.ts`, `tests/mcp/{litSearch,searchResources}.test.ts`)
   — full suite **473 passed / 4 skipped, 35 files**. All hermetic (stages mocked, resources seeded
   through the store — no live LLM/R/Ollama).

## 12. Local testing & deployment

### 12.1 Local test rig

- **Full-data local runs.** The complete corpus already lives locally (`PAPER_SEARCH_DATA_ROOT=
  /Users/ebr/eddyspapers`) with local Ollama — the same setup the skills used. Hono gets its **own
  local snapshot copy** of `articles.duckdb`; don't point Plumber and Hono at the same file (Plumber's
  pool holds a read-write lock, which excludes read-only openers — same constraint that forced
  `articles_agentic.duckdb` on prod).
- **Golden-file parity harness** (the core Phase 1/5 gate). Because of the lock constraint, parity
  testing is sequential, not side-by-side: a script first replays a battery against local Plumber and
  records responses as golden JSON (battery = top ~25 real queries reconstructible from `search_logs`
  patterns + a hand-built person-search matrix of scoring modes × filters + the citation/stats/versions
  lookups), then runs the same battery against Hono and diffs. Comparison is **rank-tolerant** for
  embedding-backed routes (top-20 overlap ≥ 18/20 and score deltas < 1e-4, not byte equality) and
  exact for pure-SQL routes (keyword, verify, citations, stats, person profile/papers).
- **Fixture DB for fast tests.** A Node script (`agentic_backend/scripts/build_fixture.ts`, run via
  `npm run build:fixture`) carves a ~3k-article fixture DuckDB from the full local corpus (all seven
  categories + matching `handle_stats`/`cit_internal`/person tables, real embeddings, plus a stored
  query vector so semantic/person tests run without Ollama). Output is gitignored under
  `agentic_backend/tests/fixtures/`; vitest integration tests (routes, SQL builders, verify-tier
  logic, later key/scope middleware and rate limiter) run against it — no 12G dependency at test time.
- **MCP smoke tests.** A scripted `@modelcontextprotocol/sdk` client exercises every tool + resource +
  prompt against the local server (both transports), asserting schemas and the `needs_clarification`
  path; plus one manual end-to-end: `claude mcp add` the local HTTP endpoint with a test key and run a
  real lit-search brief from a scratch project.
- **Embedding-drift guard.** Prod Ollama (0.5.12) trails local; before trusting parity numbers, pin
  and compare the `mxbai-embed-large` model digest local-vs-prod and embed a 10-string probe set on
  both — if vectors drift, parity failures are environmental, not code. (The Window-3 Ollama upgrade
  should land before Phase 5.)

### 12.2 Deployment per phase

- **Phases 1–4 are additive, low-risk deploys**: new code on the existing `agentic-api.service`,
  new routes/MCP on `:8001`, corpus opened read-only, `appdata.duckdb` is a brand-new file. Standard
  pattern (git pull → `npm run build` → restart service → curl smoke checks). No Plumber, nginx
  `/api/` blocks, or `articles.duckdb` changes — worst case is restarting a broken agentic service.
- **Phase 5 is the massive change** (nginx repoint for classic + econpeople, user-table migration out
  of `articles.duckdb`, Plumber retirement, snapshot-swap wiring). It runs as a gated maintenance
  window and follows §12.3 in full.

### 12.3 Prod backup + rollback runbook (mandatory before the Phase 5 window)

Ordered; abort the window if any verification step fails.

1. **Gate** the sites with the maintenance flag (`maintenance/README.md`).
2. **Stop `eddyspapers-api`** and take an on-box consistent file copy:
   `cp articles.duckdb articles.duckdb.pre_split_$(date +%Y%m%d)` (12G; disk has ~280G free — fine).
3. **Full parquet dump** via `dump_db_to_parquet()` into `full_dump_pre_split_<date>/` (~3G) —
   table-level restore capability through `restore_db_from_parquet`, independent of the file copy.
4. **Off-box copy of the user-generated tables** at minimum — `saved_searches`, `search_logs`,
   `saved_person_searches`, `person_search_logs` parquet files (tens of MB, survives the flaky home
   uplink; the 12G copy stays on-box only). These are the irreplaceable rows this whole section exists
   for.
5. **Config backup**: tar `/etc/eddyspapers.env`, `/etc/agentic.env`, `/etc/nginx/sites-available/*`,
   and the three systemd units to `/root/backups/pre_split_<date>.tar.gz`.
6. **Verify before proceeding**: open the file copy read-only, `COUNT(*)` every user table and
   `articles`, and match against the live DB's pre-stop counts recorded in step 2.
7. **Migrate + cut over**: run the user-table migration into `appdata.duckdb` (re-verify counts
   post-migration), deploy the Phase 5 build, repoint nginx, run the golden-file battery **against
   prod** through the public `/api/` paths, then drop the maintenance flag.
8. **Rollback stance**: keep the Plumber unit stopped-but-installed and the old nginx site configs
   as `.bak` for a **two-week soak**. Rollback = repoint nginx to `:8000`, start `eddyspapers-api`,
   and (only if appdata diverged) restore user tables from step 3/4. After the soak, strip Plumber
   from the R package (Phase 5's final step) and delete the on-box `.pre_split` file copy; the
   parquet dump is retained permanently.

### 12.4 Phase-exit reviews (fresh-context sub-agents)

Each phase ends with a **fresh-context sub-agent review** before it counts as done — the CLAUDE.md
workflow rule, applied at phase granularity so the reviewer never inherits the implementer's
assumptions. Two agents per phase, run in parallel:

1. **Code-quality reviewer**: reads only the phase's diff + the relevant design docs (this PLAN,
   `01_design.md` §7, `econpeople/02_api.md`), and checks style (TS: effect/pipe, no mutation, no
   `any`, remeda over hand-rolled loops; R fixture scripts: purrr, no loops), correctness against the
   documented wire shapes, and doc/code divergence (flags anything §10 must pick up).
2. **Test extender**: reads the phase's tests, hunts missing edge cases, and **writes the additional
   tests** — not just a report. Phase-specific hot spots: P1 SQL-injection surfaces in the LIKE-chain
   builder + empty/unicode keywords + person-CTE tie-breaking; P2 malformed MCP payloads, schema
   round-trips, resource-URI parsing; P3 cache-key collisions, `needs_clarification` and abort paths,
   progress-notification ordering; P4 timing-safe compare, scope escalation, limiter races at the
   boundary, revoked-key SSE behaviour; P5 the migration script on a copy of real prod data (row
   counts, hash stability of saved-search links); P6 skill-recipe dry runs against a mocked server.

Review findings are fixed (or explicitly waived in a note in the phase's commit) before the next
phase starts; for Phase 5 the review happens **before** the maintenance window, on the dual-run
deploy, not after cutover.
