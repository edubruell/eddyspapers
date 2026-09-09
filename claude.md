# Eddy's Papers — Project Guide

## What this is

Three related products sharing one DuckDB corpus (~479k economics papers from RePEC):

| Product | URL | Status |
|---|---|---|
| Classic semantic search | `econpapers.eduard-bruell.de` | Live |
| EconPeople person finder | `econpeople.eduard-bruell.de` | Live |
| Agentic literature review | `agenticsearch.eduard-bruell.de` | Live (ZEW preview) |

All three are served by **one Node/Hono service** at `:8001` (`api/`). R/Plumber is retired on prod (stopped 2026-07-11); dead code stripped and the tree restructured in M7 (2026-07-20). See `localwip/notes/architecture/01_backend_split.md` for the full architecture record.

## Folder map

```
/
├── update_repec.R          ← RECURRING cron entry point: sync → parse → embed → diff → deploy
├── deploy_diffs.sh         ← manual diff upload + /admin/reload
├── deploy_patches.sh       ← manual parquet-patch upload + /admin/reload (enrichment/backfills)
├── server_apply_diff.R     ← runs on server inside deploy_diffs.sh
├── server_apply_patch.R    ← runs on server inside deploy_patches.sh
├── diff_upload.R           ← rsync upload helper
│
├── backfills/              ← RUN-ONCE enrichment runners (NOT the cron; see backfills/README.md)
│   ├── backfill_wave1.R        M8 Wave 1 (JEL, EDIRC, journal_quality, DOI-from-redif/url)
│   └── backfill_doi_tiered.R   host-tiered DOI backfill (reusable fns live in pipeline/R/)
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
    ├── notes/              ← 3-tier notes system (see "Notes system" below)
    │   ├── perpetual/          long memory: INDEX, IDEAS, FINDINGS, CURRENT_FOCUS
    │   ├── <topic>/            per-topic plans (agentic, econpeople, data_enrichment, architecture)
    │   ├── sessions/           per-session logs (yyyymmdd_<title>.md)
    │   └── archive/            frozen historical docs
    ├── adhoc/              ← retired one-off scripts
    ├── lit-search/         ← pre-MCP skill originals (superseded by ~/.claude/skills/)
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
| `POST /chat` | Start agentic literature search (SSE stream); `synthesize` writes the review — see below |
| `POST /chat/{id}/reply` | Reply to clarifying question |
| `POST /export/xlsx` | Export results as Excel |
| `POST /signup/key` | Public self-serve MCP key: mints `["mcp","lit_search"]` and **mails** it (never returns it) |
| `GET/POST /signup/revoke` | Revoke a self-serve key + erase its stored identity (token from the key mail) |
| `PATCH /admin/keys/{prefix}` | Replace a live key's scopes in place (no reissue) |
| `POST /admin/signups/purge` | Erase one mailbox: its keys **and** its send ledger (reusable test address / erasure request) |
| `POST /admin/reload` | Hot-swap corpus snapshot (requires admin key) |
| `GET /docs` | Public JSON API reference — endpoints + field conventions (`src/docs/reference.ts`) |

### Search modes and the synthesis grant

The agentic pipeline runs **script-only by default**: the server writes and runs the search
script and returns papers + BibTeX + CSV + the script, and the caller writes its own review.
Having the *server* write the review is the only stage that costs real model tokens, so it is
opt-in (`synthesize`) **and** gated on the `lit_search_synth` key scope:

| Surface | `synthesize` default | Without `lit_search_synth` |
|---|---|---|
| MCP `lit_search` | `false` | request refused (never silently downgraded) |
| `POST /chat` (web app) | `true` | search still runs, no review; response echoes `synthesize:false` |

### Handle-plus-fetch delivery

A big run's artifacts do not fit in one tool result (a 40-paper run measured ~134k chars and
overflowed a real client's cap). MCP `lit_search` therefore takes `deliver`:
`auto` (default — inline under a 60k-char budget, handle above it), `inline`, or `handle`.
Under handle delivery the result keeps the citable digest of **every** paper plus the
`search_id`/`resource_uri`, and withholds the bulk; `fetch_search(search_id, part=…)` serves
`overview|script|bibtex|csv|papers|sections|synthesis`, paginated for the two parts that carry
abstracts. `api/src/agent/parts.ts` is the single slicer; the `agenticsearch://searches/{id}`
resources expose the same cuts for clients that read resources. `deliver` is deliberately NOT
in the cache key — delivery is presentation, so a cached run can be handed back either way.

**Run ownership.** A stored run is readable through the authenticated faces — `fetch_search` and
the `agenticsearch://searches/{id}` resources — only by a key that produced it
(`search_owners` in searches.duckdb; rule in `api/src/agent/ownership.ts`; owner recorded on
create *and* on cache hit; admin keys and the keyless stdio build pass through). The web share
surfaces `GET /searches/:id` and the SSE stream stay ungated by design — they *are* the share
link — and are protected instead by the run id being an HMAC under a server-only
`SEARCH_ID_SECRET`. **That secret is now mandatory: the service refuses to boot when the key gate
is on and it is unset.**

Scopes are `rest`, `mcp`, `lit_search`, `lit_search_synth`, `admin`; the admin console
(`/admin`) renders what each grants from the backend's `scope_docs`. Field conventions that a
caller cannot guess (notably `author_lastnames` is **semicolon-separated**) live once in
`api/src/docs/reference.ts` and are spent on both faces — MCP `.describe()` text and `GET /docs`.

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
- `saved_searches`, `search_logs`, `person_search_logs`, `api_keys`, `key_mail_log`

`api_keys` carries the self-serve signup identity (`name`, `email`, `email_canonical`,
`institution`, `verified_at`) — all NULL on operator-minted keys. `email_canonical` is the
plus-tag-stripped address and is the key for the one-key-per-mailbox rule and the mail
cooldown; `key_mail_log` is the send ledger those count. Every appdata schema change is
applied by `openAppDataDb()` at startup and folded in by the CHECKPOINT at the end of its DDL
block — that checkpoint is what keeps an `ADD COLUMN` out of a cold-restart WAL replay.

## Notes system

`localwip/notes/` (gitignored) is organised in three tiers by memory horizon — see
`localwip/notes/perpetual/INDEX.md` for the full model:

- **`perpetual/`** — long, distilled, flushable memory. `IDEAS.md` (speculative),
  `CURRENT_FOCUS.md` (active/next-up), `FINDINGS.md` (durable gotchas & measurements),
  `INDEX.md` (the map). Entries are `## Headline` + `_YYYY-MM-DD_`, newest first. **Read
  `FINDINGS.md` before debugging** — the cross-cutting landmines live there.
- **Topic folders** — long-form per-topic design plans, numbered `00_index`, `01_…`:
  - `agentic/00_overview.md` … `08_sharelinks.md` — agentic search; lower-numbered doc wins on system decisions
  - `econpeople/00_overview.md` … `03_profile_tiers.md` — EconPeople person finder
  - `data_enrichment/` — M8/M9 DOI + OpenAlex enrichment (backfill design in `01_backfill_mechanism.md`)
  - `architecture/01_backend_split.md` — the canonical backend-split / MCP architecture record
- **`sessions/`** — one short log per session, `yyyymmdd_<title>.md`.
- **`archive/`** — frozen historical docs (retired roadmap, M7/M9 write-ups, old FINDINGS).

**Session end:** run the **`lognow`** skill — it writes the `sessions/` log and harmonizes
`perpetual/` (promotes durable findings, updates `CURRENT_FOCUS`, marks todos, refreshes the
INDEX). Invoke it when wrapping up a working session.

## Pending work (next up)

**TOP GOAL — self-serve MCP key signup site** (`mcpsignup.eduard-bruell.de`). A public page:
name + email + institution (optional) → an eddysearch MCP key, plus downloads for the
lit-search / lit-check skills, and an `llms.txt` so an agent can drive the signup itself.
Full spec: `localwip/notes/public_access/01_signup_site.md`; working entry in
`perpetual/CURRENT_FOCUS.md`.

**The backend half is DONE and live on prod (2026-09-09, `a42a3e8`).** S6 run ownership, the
appdata identity migration, mail delivery through the Strato mailbox `mcpkeys@eddyspapers.org`,
`POST /signup/key`, and `POST /admin/signups/purge`. Verified against prod with real keys: a
signup mail lands, a public key gets exactly `["mcp","lit_search"]`, `synthesize:true` is
refused without `lit_search_synth`, and a second key cannot read another key's stored run.
Note `POST /api/signup/key` is **already publicly reachable**, ahead of any page advertising
it, so the D6 abuse guards (10-minute per-mailbox cooldown, 3/day per mailbox, 60/hour
globally) are load-bearing now.

The human-facing half shipped 2026-09-09 (`568ca5e` + `c40a31d`, live on prod): the `/mcp`
page on classic (signup form, tool list, three setup tabs, skill downloads, data section),
the two packaged skills in `skills/` (built by `skills/build.sh` into
`frontends/classic/public/skills/`), and an html key mail.

What is left:

1. **DNS on `eddyspapers.org`** (Strato panel, not code): SPF, DKIM, a `_dmarc` TXT at
   `p=none`. Until then every message is an unauthenticated first-time sender, which is what
   greylisted the first zew.de mail. Do it before advertising the page widely.
2. **`llms.txt`**, describing a route that already works.
3. **The GUI connector gap.** The visual "add a custom connector" flow has no field for a
   header, and `/mcp` only reads the key from `Authorization`/`X-API-Key`, so the page routes
   desktop users through the `npx mcp-remote` bridge. Supporting point-and-click means
   accepting a token in the URL (history, referrers, logs) — an open decision, not a bug.
4. **A narrow `rest_read` scope**, if a scripting audience ever matters. Public keys cannot use
   the REST API today because `rest` also opens `/chat`, `/export/*` and the two `/dailylogs`
   routes (raw search logs with IPs).

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
2. Update the relevant topic doc / `perpetual/CURRENT_FOCUS.md` checklist.
3. If implementation diverges from a design doc, update the doc — code and docs must stay in sync.

At session end, run the **`lognow`** skill to write the session log and harmonize `perpetual/`.

**Frontend dev:** `cd frontends/classic && npm install && npm run dev` (or `frontends/econpeople`)  
**API dev:** `pnpm install` at the repo root, then `cd api && pnpm dev`  
**API endpoint (local):** `http://127.0.0.1:8001`
