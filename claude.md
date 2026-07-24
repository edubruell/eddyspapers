# Eddy's Papers — Project Guide

## What this is

Three related products sharing one DuckDB corpus (~479k economics papers from RePEC):

| Product | URL | Status |
|---|---|---|
| Classic semantic search | `econpapers.eduard-bruell.de` | Live |
| EconPeople person finder | `econpeople.eduard-bruell.de` | Live |
| Agentic literature review | `agenticsearch.eduard-bruell.de` | Live (ZEW preview) |

All three are served by **one Node/Hono service** at `:8001` (`api/`). R/Plumber is retired on prod (stopped 2026-07-11); dead code stripped and the tree restructured in M7 (2026-07-20). See `localwip/notes/PLAN.md` for the full architecture record.

## Folder map

```
/
├── update_repec.R          ← cron entry point: sync → parse → embed → diff → deploy
├── deploy_diffs.sh         ← manual diff upload + /admin/reload
├── server_apply_diff.R     ← runs on server inside deploy_diffs.sh
├── diff_upload.R           ← rsync upload helper
│
├── pipeline/               ← R package `eddyspapersbackend` (pipeline only — no serving)
│   ├── R/                  ← config, folders, sync, parse, database, handle_stats,
│   │                          persons, persons_wikidata, update_logs
│   └── inst/scripts/       ← Perl ReDIF parsers
│
├── api/                    ← Node/Hono API service (serves ALL three products)
│   ├── src/                ← routes, search, auth, db, mcp, sandbox
│   ├── tests/
│   └── scripts/            ← parity harness, key CLI, migration tools
│
├── sandbox/                ← eddysearch.sandbox R package + subprocess runner (run.R, check.R)
│
├── frontends/              ← all three Astro+React UIs (shared palette)
│   ├── classic/            ← econpapers
│   ├── econpeople/         ← econpeople
│   └── agentic/            ← agenticsearch
│
├── assets/                 ← shared source assets (logo, screenshot)
├── stats/                  ← analysis scripts and cached data
├── maintenance/            ← static maintenance page
├── ops_notes/              ← gitignored server-ops notes
└── localwip/               ← gitignored scratch
    ├── notes/              ← PLAN.md, FINDINGS.md, roadmap.md, M7_restructure.md
    ├── adhoc/              ← retired one-off scripts
    ├── lit-search/         ← skill WIP
    └── lit-check/
```

The pnpm workspace root is the repo root and covers `api` and `frontends/agentic`; `frontends/classic` and `frontends/econpeople` are standalone npm projects.

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
1. Sync journals + EDIRC + iscited (rsync)
2. Parse RDF files
3. Embed & populate articles table (incl. doi from ReDIF)
4. Populate JEL tables (article_jel from RDS cache, jel_codes from AEA XML)
5. Write version links
6. Parse & populate cit_all, build cit_internal
7. Compute handle_stats
8. Refresh persons (+ person_workplaces), EDIRC institutions, Wikidata
9. Refresh journal_quality (RePEc seriesfactors)
10. Dump to parquet (full + diff)
11. Deploy diff → server (deploy_diffs.sh) if EDDY_DEPLOY=1
```

Backfills/enrichment updates travel as **parquet patches** (not diffs): `write_patch()` /
`apply_patch()` in the pipeline package, shipped with `deploy_patches.sh` →
`server_apply_patch.R`. Schema changes live in `migrate_schema()` (pipeline/R/migrate.R).
Design: `localwip/notes/data_enrichment/01_backfill_mechanism.md`.

## DuckDB tables

**Corpus (articles_agentic.duckdb — read-only for Hono):**
- `articles` — papers with embeddings (HNSW index) + `doi`/`doi_source` (M8)
- `cit_all` — full citation graph (~36M edges)
- `cit_internal` — both-ends-in-corpus subgraph
- `handle_stats` — precomputed citation + impact metrics
- `version_links` — paper version relationships
- `journals` — journal metadata
- `bib_coupling` — precomputed bibliographic coupling
- `persons`, `person_works`, `person_stats`, `person_wikidata` — EconPeople tables
- `article_jel` (handle lowercase; ~55% coverage, NULL = unknown), `jel_codes` — JEL (M8)
- `institutions` (EDIRC), `person_workplaces` (all affiliations + shares) — M8
- `journal_quality` — RePEc series impact factors (experimental; one signal among several) — M8

**Appdata (appdata.duckdb — Hono read-write):**
- `saved_searches`, `search_logs`, `person_search_logs`, `api_keys`

## Design docs

All design docs are in `localwip/notes/` (gitignored):
- `localwip/notes/agentic/00_overview.md` … `08_sharelinks.md` — agentic search; lower-numbered doc wins on system decisions
- `localwip/notes/econpeople/00_overview.md` … `03_profile_tiers.md` — EconPeople person finder

## Pending work (next up)

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
2. Update `localwip/notes/agentic/05_roadmap.md` (or relevant phase checklist).
3. If implementation diverges from a design doc, update the doc — code and docs must stay in sync.

**Frontend dev:** `cd frontends/classic && npm install && npm run dev` (or `frontends/econpeople`)  
**API dev:** `pnpm install` at the repo root, then `cd api && pnpm dev`  
**API endpoint (local):** `http://127.0.0.1:8001`
