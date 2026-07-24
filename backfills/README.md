# One-off backfills

Run-once orchestration scripts for a specific data-enrichment wave. They are **not**
part of the recurring cron pipeline (`../update_repec.R`) and are not meant to run on a
schedule — each one populates or corrects data once, ships a patch to prod, then is done.

They live here (not at the repo root, next to the cron entry point) precisely so the
recurring vs. one-off boundary is obvious.

## What's reusable lives in the package, not here

These runners are thin: they set the data root, pick a route, and call **library
functions** in the `eddyspapersbackend` package (`../pipeline/R/`). Anything reusable —
`build_doi_patch`, `finalize_doi_patch`, `nature_safe_doi`, `container_backfill_openalex`,
`openalex_lookup_dois`, `title_sim`, the patch mechanism — is package code with man pages
and unit tests. A backfill script is just the specific invocation that ran on a given day.
Wave 2 will call the same functions from a new runner here.

## Scripts

| script | what it did | shipped |
|---|---|---|
| `backfill_wave1.R` | M8 Wave 1: JEL tables, EDIRC institutions, journal_quality, person_workplaces, DOI-from-redif/url patch | 2026-07-24 |
| `backfill_doi_tiered.R` | Host-tiered DOI backfill (Nature `10.1038/<id>` transform + container route → `finalize_doi_patch`) | Nature shipped 2026-07-24; container deferred to Wave 2 |

## Ship path (baseline-reset rule)

Every backfill that changes corpus data follows the same route:

```
build the patch  ->  apply_all_patches (local)  ->  dump_db_to_parquet  ->  ./deploy_patches.sh
```

Applying locally then re-dumping keeps the next cron diff's baseline consistent with prod.
Design records: `../localwip/notes/data_enrichment/` (`00_plan.md`, `04_tiered_doi.md`).
