#!/usr/bin/env Rscript
# Phase B (08_title_match.md): close the DOI gap for the DOI-less NON-series
# residual by matching corpus papers to the free OpenAlex CC0 S3 snapshot on
# source + year + title. Widens Track A (05_wave2_container.md) past the eight
# publisher hosts to the whole non-series residual (~48.6k papers / 86 sources,
# 99.9% resolvable) and runs the matcher with the fuzzy stage on.
#
#   sources -> cache the (small) OpenAlex journal-sources table locally
#   resolve -> map ALL DOI-less non-series journals (>= min_papers) to source ids
#   pull    -> scan the works snapshot for those sources -> local parquet
#              (network-bound, resumable, watchdog-driven)
#   match   -> match by source+year+title (exact + fuzzy) -> openalex_attempts.parquet
#
# Then fold + ship with the tiered runner's finalize + the baseline-reset rule:
#   Rscript backfills/backfill_doi_tiered.R finalize
#   Rscript -e 'eddyspapersbackend::run_backfill()'   # apply + baseline dump
#   ./deploy_patches.sh                                # + systemctl restart, NOT /admin/reload
#
# Usage (from repo root):
#   Rscript backfills/backfill_doi_title_match.R            # all four steps
#   Rscript backfills/backfill_doi_title_match.R sources
#   Rscript backfills/backfill_doi_title_match.R resolve
#   Rscript backfills/backfill_doi_title_match.R pull
#   Rscript backfills/backfill_doi_title_match.R match

suppressMessages(library(eddyspapersbackend))
Sys.setenv(PAPER_SEARCH_DATA_ROOT = "/Users/ebr/eddyspapers")
config <- get_folder_config(); create_log_file(config)

MIN_PAPERS <- 20L

db_path    <- file.path(config$db_folder, "articles.duckdb")
oa_dir     <- file.path(config$data_root, "openalex")
dir.create(oa_dir, showWarnings = FALSE, recursive = TRUE)
src_path   <- file.path(oa_dir, "sources.parquet")
map_path   <- file.path(oa_dir, "srcmap_titlematch.parquet")
works_dir  <- file.path(oa_dir, "works_titlematch")
works_glob <- file.path(works_dir, "*.parquet")

route <- commandArgs(trailingOnly = TRUE)[1] %||% "all"

do_sources <- function() cache_openalex_sources(src_path)

do_resolve <- function() {
  journals <- doi_less_journals(db_path, min_papers = MIN_PAPERS)
  info("Resolving ", nrow(journals), " DOI-less non-series journals (",
       sum(journals$n), " papers)")
  map <- resolve_container_sources(journals, src_path) |>
    dplyr::left_join(journals, by = "journal")
  arrow_free_write(map, map_path)
  info("Resolved ", sum(!is.na(map$src_id)), "/", nrow(map), " journals (",
       sum(map$n[!is.na(map$src_id)]), " papers) -> ", map_path)
}

do_pull <- function() {
  map <- read_srcmap()
  ids <- unique(map$src_id[!is.na(map$src_id)])
  info("Pulling works for ", length(ids), " sources into ", works_dir)
  pull_openalex_source_works(ids, works_dir)
}

do_match <- function() {
  map <- read_srcmap()
  hits <- container_backfill_snapshot(db_path = db_path, works_glob = works_glob,
                                      srcmap = map, fuzzy = TRUE)
  info("Title match complete: ", nrow(hits), " new DOIs -> openalex_attempts.parquet")
}

# small local helpers (avoid arrow: duckdb COPY only) ------------------------
arrow_free_write <- function(df, path) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  duckdb::duckdb_register(con, "df", df)
  DBI::dbExecute(con, sprintf("COPY df TO '%s' (FORMAT parquet)", path))
}
read_srcmap <- function() {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  tibble::as_tibble(DBI::dbGetQuery(con, sprintf("SELECT * FROM read_parquet('%s')", map_path)))
}

switch(route,
  sources = do_sources(),
  resolve = do_resolve(),
  pull    = do_pull(),
  match   = do_match(),
  all     = { do_sources(); do_resolve(); do_pull(); do_match() },
  stop("unknown route: ", route))

info("Done (", route, "). Next: Rscript backfills/backfill_doi_tiered.R finalize")
