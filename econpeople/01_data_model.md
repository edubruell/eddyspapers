# econpeople — Data model & ingestion (design draft)

How RePEc `pers` data gets into the DuckDB and becomes searchable. This is the
core of the first build. Decisions marked **[OPEN]** await a direction call.

Lower-numbered design docs win for system decisions; this doc owns the person
data model. It must stay consistent with how `backend/R/` already does sync →
parse → populate → stats → dump/diff (see `update_repec.R`).

## 0. Source format recap

One file per author under `RePEc/per/pers/<letter>/<short_id>.rdf`, template
`ReDIF-Person 1.0`. Relevant fields (from real records):

```
Name-First / Name-Middle / Name-Last / Name-Full
Workplace-Name           multi-line, "/"-continued
Workplace-Institution:   RePEc:edi:edmitus      (EDI institution handle)
Homepage / Phone / Postal / Email
author-paper:    repec:nbr:nberwo:14674          (registered works — repeatable)
author-article:  repec:aea:aecrev:v:100:...
author-chapter:  repec:eee:ecochp:6b-72
author-software: ...
editor-series:   repec:ect:emjrnl
Short-Id:        pac16                            (stable canonical author id)
Handle:          REPEC:per:1970-05-21:jaap_abbring
Registered-Date / Last-Login-Date
```

- **`Short-Id` is the canonical key.** Unique per registered author, matches the
  filename. Use it as the primary key everywhere. (`Handle` is also unique but
  longer/uglier; keep it as a column, don't key on it.)
- Work handles use lowercase `repec:`; corpus handles in `articles` use mixed
  case. **Normalise to lower-case on both sides for joins** (the citation code
  already does this — `build_internal_citation_graph` joins on `LOWER(Handle)`).
- A record may have **multiple workplaces** (repeated `Workplace-*` blocks). We
  keep the **first/primary** in `persons` and, if useful, all of them in a small
  side table. **[OPEN-5]** keep secondary affiliations or drop them?

## 1. Parsing

Reuse the existing Perl ReDIF backend (`backend/inst/scripts/parse_redif_simple.pl`)
— it already parses *any* template including `ReDIF-Person`, and it's battle-
tested on 84k-file scales. Add an R post-processor mirroring the article path:

- `parse_all_persons(pers_folder, rds_folder_persons)` — analogous to
  `parse_all_journals`; walks `per/pers/**`, calls the Perl parser, writes RDS
  shards. Functional/purrr, no loops, per project style.
- `post_process_person_entry(entry)` — turns one parsed record into a tidy row:
  scalar fields + **list-columns** `works` (tibble of `handle`, `type`) and
  optional `workplaces`. Multi-line fields (`Workplace-Name`, `Postal`)
  collapsed with the `/`/newline convention already used for articles.

Output of the parse stage: a `persons_raw` tibble (one row per `Short-Id`, with a
nested `works` list-column). Everything downstream is derived from it.

> Alternative considered: parse the simple key/value format directly in R
> (no Perl). Cleaner dependency story, but diverges from the established parser
> path and re-implements multi-line/continuation handling. Default to **reuse
> Perl** for consistency; revisit only if it's a bottleneck.

## 2. Tables

Four new tables, following the project's "separate tables, precompute, avoid
SQL-spaghetti" rules. All keyed on `short_id`.

### `persons` — one row per registered author
```
short_id              VARCHAR  PRIMARY KEY     -- "pac16"
name_first            VARCHAR
name_last             VARCHAR
name_full             VARCHAR
workplace_name        VARCHAR                  -- primary affiliation (display)
workplace_institution VARCHAR                  -- EDI handle "RePEc:edi:edmitus"
homepage              VARCHAR                  -- linked on the public profile
handle                VARCHAR                  -- full RePEc:per:... handle
registered_date       DATE
last_login_date       DATE
```
**[D-4] Personal data — professional identity only.** We store and display
name, affiliation, and **homepage** (linked), plus derived stats and works.
**`email` is not exposed** and **`phone`/`postal` are dropped entirely** (not
parsed into the table). The data is public on RePEc, but re-publishing
searchable contact info is a different processing basis and not worth the GDPR
friction for a German-hosted site. If an internal-only email is ever needed
(e.g. an admin "contact" action), it lives in a separate access-controlled table,
never in `persons`.

### `person_works` — author ↔ work edge list (the linkage backbone)
```
short_id    VARCHAR    -- FK to persons
work_handle VARCHAR    -- LOWER-cased repec handle
work_type   VARCHAR    -- 'paper' | 'article' | 'chapter' | 'software' | 'editor'
-- indices on (short_id) and (work_handle)
```
`work_handle` indexed both ways → fast "this author's papers" and "who authored
this paper". Join `work_handle` ↔ `LOWER(articles.Handle)` to restrict to corpus.

### `person_stats` — precomputed impact/profile (mirrors `handle_stats`)
Computed during the pipeline, **not at query time**. Joins `person_works` to
`articles` / `handle_stats`. Indicative columns:
```
short_id           VARCHAR PRIMARY KEY
n_works_total      INTEGER   -- all registered works (in or out of corpus)
n_works_in_corpus  INTEGER   -- works present in articles
total_citations    INTEGER   -- sum over in-corpus works (from handle_stats)
top5_count         INTEGER   -- in-corpus works in "Top 5 Journals"
a_count            INTEGER   -- in "Top Field Journals (A)"
first_year         INTEGER
last_year          INTEGER
primary_category   VARCHAR   -- modal journal category of their corpus works
n_coauthors        INTEGER   -- distinct coauthors within corpus (optional v1)
```
This is what powers ranking, filters, and the profile header without runtime
joins.

### `person_embeddings` — **deferred, not built for v1**
**[D-2]** Topic search does **not** use per-author vectors (averaging an author's
embeddings blends unrelated research lines — Acemoglu's automation work with his
democracy work). The semantic search is done at query time by two-stage overlap
retrieval (§3.5), which reuses the existing `articles` HNSW index and needs no
author vectors. A precomputed author-centroid table may return later purely as a
latency optimisation for "authors similar to author Y"; it is out of scope now.

## 3. Linkage to the corpus

Single deterministic join, no fuzzy matching, for registered authors:
```sql
SELECT pw.short_id, a.*
FROM person_works pw
JOIN articles a ON LOWER(a.Handle) = pw.work_handle
```
Coverage is partial by construction (we track a curated journal set with year
cutoffs), and that's fine — the in-corpus subset is exactly the part we have
embeddings and citation stats for.

**[D-1] non-registered authors deferred.** The `articles.authors` field is free
text; mining persons from it needs name disambiguation (hard, error-prone).
v1 is **registered-only**; free-text mining is a later, clearly-heuristic layer
if at all.

## 3.5 Topic → author search (two-stage overlap retrieval)

This is the headline feature and the reason `person_embeddings` is unnecessary.
Given a natural-language query, rank authors by how much of the relevant
*paper-level* literature is theirs.

**Stage 1 — hidden paper search.** Embed the query the same way base eddyspapers
does (mock-abstract / HyDE style, see commit `9d4d3e9`), then HNSW-search
`articles` for the top **K** papers (K large, e.g. 500–2000), keeping
`(handle, similarity)`. This is exactly the classic search, just with a big K and
not shown to the user.

**Stage 2 — roll up to authors.** Join the top-K handles to `person_works`
(indexed on `work_handle`) and aggregate per `short_id`:

```sql
WITH hits AS (  -- top-K papers from the vector search, with scores
  SELECT LOWER(Handle) AS work_handle, score FROM <vector_search_result>
)
SELECT pw.short_id,
       COUNT(*)                         AS n_matched,
       SUM(hits.score)                  AS overlap_weight,
       MAX(hits.score)                  AS best_score,
       LIST(hits.work_handle ORDER BY hits.score DESC)[1:5] AS evidence
FROM hits
JOIN person_works pw ON pw.work_handle = hits.work_handle
GROUP BY pw.short_id
ORDER BY overlap_weight DESC
```

**Ranking signal.** Base relevance `overlap_weight = Σ similarity` of an author's
papers inside top-K — rewards both volume *and* closeness. Guards against a
mega-author dominating by sheer count:
- only count papers above a similarity floor, and/or
- cap each author's contribution (e.g. top-m papers per author), and/or
- blend with a normalised `best_score` so a focused author with 2 perfect hits
  can outrank a prolific author with 30 tangential ones.

**[D-5] Quality signal — a small, toggle-able blend.** Topical relevance leads,
but a bit of *prominence* should shape the default order so the strong people on
a topic float up. Final score:

```
score = overlap_weight * (1 + λ · quality_norm)
```

where `quality_norm ∈ [0,1]` is a normalised impact signal from `person_stats`
(e.g. log citations, or a mix of citations + Top-5 count), and `λ` is small by
default (≈0.3 — relevance still dominates). The API exposes this as a **toggle**
(`quality_weight`): `0` = pure topical relevance, default = light prominence
blend, higher = prominence-leaning. Exact `quality_norm`/`λ` are tuning knobs, not
schema — start simple and iterate against real queries.

**Evidence.** Return each author's top matched papers so the UI can show *why*
they surfaced ("matched on these 5 papers"). This is the explainability win over
a single opaque author vector.

**Why this is cheap & correct.** Stage 1 is one HNSW query (already fast); Stage 2
is an indexed join + group-by over K rows (tiny). Nothing precomputed, nothing
stale, and multi-field authors rank correctly per query. `person_stats` (citations,
Top-5 count, recency) can be mixed into the final sort as secondary signals.

## 4. Pipeline integration (`update_repec.R`)

Insert a person block after the citation/stats steps, before the parquet dump, so
person stats can read freshly-updated `articles`/`handle_stats`:

```
... existing steps 1–6 (sync, parse, embed, version links, citations, handle_stats) ...
[7] Sync pers archive          sync_repec_pers()        # exists (see fix below)
[8] Parse pers RDF             parse_all_persons()
[9] Populate persons + works   populate_persons()
[10] Compute person_stats      compute_person_stats(con)
[11] Backup (dump to parquet)  dump_db_to_parquet()     # + person tables
... then diff/deploy as today ...
```

Each step wrapped in the same `tryCatch`/`info("✓ …")` pattern as the existing
script. Person steps are **non-fatal** relative to the core paper pipeline: a
person-stage failure should log and continue, not abort a successful paper
update (mirrors the `[7/7] backup` non-fatal pattern).

### Dump / diff / deploy reuse

The parquet dump/diff/apply machinery is table-list driven. Add the three durable
person tables to the existing lists so they ride the **same** weekly deploy with
no new transport code:
- `dump_db_to_parquet()` keep-list → add `persons`, `person_works`, `person_stats`.
- `compute_parquet_diffs()` / `apply_parquet_diffs()` `tables` + `table_keys`:
  - `persons` key `short_id`
  - `person_works` key `(short_id, work_handle)`
  - `person_stats` key `short_id`

So `deploy_diffs.sh` + `server_apply_diff.R` carry person updates **for free**
once these tables are in the lists. (No `person_embeddings` — deferred per
[D-2].)

## 5. Housekeeping prerequisites

- **`sync_repec_pers()` is unexported** — present in `backend/R/sync.R` with
  `@export` but missing from `NAMESPACE` (we had to call it `:::`). Run
  `devtools::document()` so the pipeline can call it normally.
- Add a folder ref for parsed person RDS (e.g. `config$rds_persons_folder`) in
  `config.R`/`folders.R`, mirroring `rds_folder`. The raw `pers` archive already
  lands under `config$repec_folder/per/pers` via the existing sync.
- Person `Short-Id`s are recyclable in principle but stable in practice; treat as
  immutable PK and let the diff machinery handle adds/updates/deletes.

## 7. Stack & placement [D-3]

**Backend — shared.** Person endpoints extend the existing `eddyspapersbackend`
(R/Plumber): new `R/persons.R` (parse/populate/stats) + person routes in `api.R`.
They read the same DuckDB and ship through the same `run_api.R` / deploy. Maximal
infra reuse, no second data layer.

**Frontend — separate app, shared design.** The person finder is its own
Astro/React app (Diogenes-meerkat branding) — close in layout to the classic UI
(query box → ranked cards; two-phase landing/results) but a distinct codebase so
it can evolve independently. Most primitives/palette come from the classic
`frontend/` and the agentic interface system (`agentic/03_interface.md`).

**Rename the classic frontend.** With three surfaces (papers, agentic, people),
the bare `frontend/` name is ambiguous. Proposed: rename `frontend/` →
`frontend_econpapers/` (sibling to `agentic/agentic_frontend/` and a future
`econpeople/econpeople_frontend/`). This touches build/deploy config and `api.js`
references, so it's a **separate confirmed change**, not part of this design.
Tracked here so the doc and the eventual layout agree.

Endpoint surface (routes, payloads, ranking params, profile shape) and the UI
spec live in `03_api_and_frontend.md`, written once this data model is approved.

## 8. Still-open (low-stakes)

- **[OPEN-5]** secondary affiliations: keep all `Workplace-*` blocks in a thin
  `person_affiliations` side table, or store only the primary in `persons`.
  Default: primary in `persons` now; add the side table only if a use surfaces.
