#!/usr/bin/env Rscript
# Wave 2 container DOI backfill via the free OpenAlex CC0 S3 snapshot.
#
# The OpenAlex *API* container route is paid ($0.001/req); this route joins the
# free parquet snapshot instead. Pipeline:
#
#   sources  -> cache the (small) OpenAlex journal-sources table locally
#   resolve  -> map corpus container journals to OpenAlex source ids
#   pull     -> scan the works snapshot for those sources -> local parquet
#               (~2h, network-bound; resumable per update-month)
#   match    -> match DOI-less container papers by source+year+title Jaccard,
#               writing the openalex_attempts.parquet ledger
#
# Then fold + ship with the tiered runner's finalize + the baseline-reset rule:
#   Rscript backfills/backfill_doi_tiered.R finalize
#   apply_all_patches (local) -> dump_db_to_parquet -> ./deploy_patches.sh
#
# Usage (from repo root):
#   Rscript backfills/backfill_doi_snapshot.R            # all four steps
#   Rscript backfills/backfill_doi_snapshot.R sources
#   Rscript backfills/backfill_doi_snapshot.R resolve
#   Rscript backfills/backfill_doi_snapshot.R pull
#   Rscript backfills/backfill_doi_snapshot.R match

suppressMessages(library(eddyspapersbackend))
Sys.setenv(PAPER_SEARCH_DATA_ROOT = "/Users/ebr/eddyspapers")
config <- get_folder_config(); create_log_file(config)

db_path  <- file.path(config$db_folder, "articles.duckdb")
oa_dir   <- file.path(config$data_root, "openalex")
dir.create(oa_dir, showWarnings = FALSE, recursive = TRUE)
src_path <- file.path(oa_dir, "sources.parquet")
map_path <- file.path(oa_dir, "srcmap.parquet")
works_dir<- file.path(oa_dir, "works")
works_glob <- file.path(works_dir, "*.parquet")

route <- commandArgs(trailingOnly = TRUE)[1] %||% "all"

do_sources <- function() {
  cache_openalex_sources(src_path)
}
do_resolve <- function() {
  journals <- container_doi_less_journals(db_path)
  info("Resolving ", nrow(journals), " container journals (", sum(journals$n), " papers)")
  map <- resolve_container_sources(journals, src_path) |>
    dplyr::left_join(journals, by = "journal")
  arrow_free_write(map, map_path)
  info("Resolved ", sum(!is.na(map$src_id)), "/", nrow(map), " journals -> ", map_path)
}
do_pull <- function() {
  map <- read_srcmap()
  ids <- unique(map$src_id[!is.na(map$src_id)])
  info("Pulling works for ", length(ids), " sources into ", works_dir)
  pull_openalex_source_works(ids, works_dir)
}
do_match <- function() {
  map <- read_srcmap()
  hits <- container_backfill_snapshot(db_path = db_path, works_glob = works_glob, srcmap = map)
  info("Snapshot match complete: ", nrow(hits), " new DOIs -> openalex_attempts.parquet")
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
