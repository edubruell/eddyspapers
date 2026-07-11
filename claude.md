# Eddy's Papers — Project Guide

## What this is

Three related products sharing one DuckDB corpus (~479k economics papers from RePEC):

| Product | URL | Status |
|---|---|---|
| Classic semantic search | `econpapers.eduard-bruell.de` | Live |
| EconPeople person finder | `econpeople.eduard-bruell.de` | Live |
| Agentic literature review | `agenticsearch.eduard-bruell.de` | Live (ZEW preview) |

All three are served by **one Node/Hono service** at `:8001` (`agentic/agentic_backend/`). R/Plumber is retired on prod (stopped 2026-07-11); dead code stripped in M7 (~2026-07-25). See `localwip/notes/PLAN.md` for the full architecture record.

## Folder map

```
/
├── update_repec.R          ← cron entry point: sync → parse → embed → diff → deploy
├── deploy_diffs.sh         ← manual diff upload + /admin/reload
├── server_apply_diff.R     ← runs on server inside deploy_diffs.sh
│
├── backend/                ← R package `eddyspapersbackend` (pipeline-only after M7)
│   └── R/                  ← config, folders, sync, parse, database, handle_stats,
│                              persons, persons_wikidata, update_logs
│
├── agentic/
│   ├── 00–08_*.md          ← design docs (canonical — read before changing a subsystem)
│   ├── agentic_backend/    ← Node/Hono API service (serves ALL three products)
│   │   ├── src/            ← routes, search, auth, db, mcp, sandbox
│   │   ├── tests/
│   │   └── scripts/        ← parity harness, key CLI, migration tools
│   ├── agentic_frontend/   ← Astro+React UI for agenticsearch
│   └── r/                  ← eddysearch.sandbox R package + subprocess runner
│
├── frontend/               ← Astro+React UI for classic search (econpapers)
├── econpeople_frontend/    ← Astro+React UI for EconPeople
├── econpeople/             ← EconPeople design docs (00–03_*.md)
│
├── stats/                  ← analysis scripts and cached data
├── maintenance/            ← static maintenance page
├── ops_notes/              ← gitignored server-ops notes
└── localwip/               ← gitignored scratch
    ├── notes/              ← PLAN.md, FINDINGS.md, roadmap.md, M7_restructure.md
    ├── lit-search/         ← skill WIP
    └── lit-check/
```

**Post-M7 restructure planned** (~2026-07-25): rename `backend/` → `pipeline/`, `agentic/agentic_backend/` → `api/`, group UIs under `frontends/`. See `localwip/notes/M7_restructure.md`.

## Service architecture

```
R pipeline (cron / update_repec.R)
  └─ writes articles.duckdb  ──atomic swap──▶  articles_agentic.duckdb (read-only snapshot)
                                                        │
                                              eddyspapers-api (Node/Hono :8001)
                                                   ├─ /search, /person/*, /stats/*
                                                   ├─ /cites, /citedby, /handlestats
                                                   ├─ /mcp  (MCP-over-HTTP)
                                                   └─ /chat, /export/*  (agentic pipeline)
                                                        └─ R sandbox subprocess (lit_search)

nginx
  ├─ econpapers.* → /api/* → :8001
  ├─ econpeople.* → /api/* → :8001
  └─ agenticsearch.* → /api/*, /mcp → :8001

User data (saved searches, API keys, logs) lives in a separate appdata.duckdb
owned by the Hono service — never touched by the pipeline.
```

## API endpoints

| Verb + path | Description |
|---|---|
| `POST /search` | Semantic search with filters (year, journal, title, author) |
| `POST /search/save` | Save a search; returns deterministic hash |
| `GET /search/{hash}` | Load a saved search |
| `GET /versions?handle=` | All known versions of a paper |
| `GET /cites?handle=&limit=` | Papers referenced by handle (internal) |
| `GET /citedby?handle=&limit=` | Papers citing handle (internal) |
| `GET /citationcounts?handle=` | Total vs internal citation counts |
| `GET /handlestats?handle=` | Full precomputed citation + impact stats |
| `GET /stats/journals` | Article counts by journal/category |
| `GET /stats/last_updated` | Date of last pipeline run |
| `POST /person/search` | Two-stage author search (semantic → rollup) |
| `GET /person/{short_id}` | Person profile |
| `GET /person/{short_id}/papers` | Papers by person |
| `POST /chat` | Start agentic literature review (SSE stream) |
| `POST /chat/{id}/reply` | Reply to clarifying question |
| `POST /export/xlsx` | Export results as Excel |
| `POST /admin/reload` | Hot-swap corpus snapshot (requires admin key) |

## Pipeline (update_repec.R)

```
1. Sync journals (rsync)
2. Parse RDF files
3. Embed & populate articles table
4. Write version links
5. Sync iscited.txt
6. Parse & populate cit_all
7. Build cit_internal
8. Compute handle_stats
9. Refresh persons + Wikidata
10. Dump to parquet (full + diff)
11. Deploy diff → server (deploy_diffs.sh) if EDDY_DEPLOY=1
```

## DuckDB tables

**Corpus (articles_agentic.duckdb — read-only for Hono):**
- `articles` — papers with embeddings (HNSW index)
- `cit_all` — full citation graph (~36M edges)
- `cit_internal` — both-ends-in-corpus subgraph
- `handle_stats` — precomputed citation + impact metrics
- `version_links` — paper version relationships
- `journals` — journal metadata
- `bib_coupling` — precomputed bibliographic coupling
- `persons`, `person_works`, `person_stats`, `person_wikidata` — EconPeople tables

**Appdata (appdata.duckdb — Hono read-write):**
- `saved_searches`, `search_logs`, `person_search_logs`, `api_keys`

## Agentic search design docs

Read in order; lower-numbered doc wins on system decisions.

| # | File | Owns |
|---|---|---|
| 00 | `agentic/00_overview.md` | direction, glossary, hard decisions, non-goals |
| 01 | `agentic/01_design.md` | pipeline, sandbox, SSE protocol, wire schemas, MCP, failure modes |
| 02 | `agentic/02_implementation_plan.md` | repo layout, model selection, OpenRouter caching |
| 03 | `agentic/03_interface.md` | UX: palette, layout, stepper, microcopy, branding |
| 04 | `agentic/04_prompts.md` | context engineering, per-stage prompts, retry strategy |
| 05 | `agentic/05_roadmap.md` | phase plan with acceptance criteria |
| 06 | `agentic/06_clarifier.md` | blocking-clarifier design (extends 01/03/04) |
| 07 | `agentic/07_multistage.md` | results-aware re-run loop (extends 01/03/04) |
| 08 | `agentic/08_sharelinks.md` | read-only share-link permalinks (extends 01/03) |

## EconPeople design docs

`econpeople/00_overview.md` → `01_data_model.md` → `02_api.md` → `03_profile_tiers.md`

## Pending work (next up)

- **M7 strip** (~2026-07-25): delete dead Plumber code from `backend/`; see `localwip/notes/M7_restructure.md` for the full strip + restructure plan.
- **HNSW cosine index**: rebuild `WITH (metric='cosine')` in `create_indices()` — current index uses l2sq.
- **Phase 6**: rewrite `lit-search` + `lit-check` skills against the MCP server (currently in `localwip/`).
- **Quality-weight parity cases**: re-add to parity battery after confirming blended mode matches (vectorised-ifelse bug was fixed locally; not yet golden-recorded).

## Technical stack

**Pipeline (R):** tidyverse, tidyllm (Ollama/mxbai-embed-large), DuckDB, arrow, jsonlite, rprojroot

**API service (Node/Hono):** TypeScript, Hono, @duckdb/node-api, @modelcontextprotocol/sdk, exceljs, vitest

**Frontends:** Astro + React (all three UIs share the same palette)

**Infra:** nginx reverse proxy, systemd (`eddyspapers-api.service`), Ollama local embeddings

**External requirements:** Perl + ReDIF-perl modules (parsing), rsync (sync)

## Code style

- R: purrr/functional, no loops; folder factory for all paths; work in DB, avoid SQL spaghetti
- TypeScript: functional/pipe style, no mutation, no `any`
- No comments unless the WHY is non-obvious
- No backwards-compat shims

## Development workflow

After every implementation step:
1. Spawn a fresh sub-agent (`Agent` with `subagent_type: general-purpose`) to review code quality and extend tests.
2. Update `agentic/05_roadmap.md` (or relevant phase checklist).
3. If implementation diverges from a design doc, update the doc — code and docs must stay in sync.

**Frontend dev:** `cd frontend && npm install && npm run dev`  
**API dev:** `cd agentic/agentic_backend && pnpm install && pnpm dev`  
**API endpoint (local):** `http://127.0.0.1:8001`
