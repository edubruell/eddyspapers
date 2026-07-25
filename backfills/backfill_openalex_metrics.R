#!/usr/bin/env Rscript
# Wave 2 Track B: OpenAlex work-level metrics for every DOI'd corpus paper,
# from the free OpenAlex CC0 S3 snapshot (the API is paid). Because the corpus
# now carries DOIs (Wave 1 url/redif + Wave 2 container), the join key is the
# DOI — so this covers the whole DOI'd corpus, not just container journals.
#
#   dois   -> dump the corpus's distinct DOIs to a local parquet
#   pull   -> scan the works snapshot (partitioned by updated_date), keep the
#             flat metric columns of rows whose DOI is in the corpus set, into
#             per-chunk local parquet (network-bound, resumable, watchdog-driven)
#   patch  -> build article_openalex (DOI-join, freshest work per DOI) and write
#             the replace_table patch
#
# Then ship with the standard backfill flow:
#   Rscript -e 'eddyspapersbackend::run_backfill()'   # apply + baseline dump
#   ./deploy_patches.sh
#
# Usage (from repo root):
#   Rscript backfills/backfill_openalex_metrics.R           # all three steps
#   Rscript backfills/backfill_openalex_metrics.R dois
#   Rscript backfills/backfill_openalex_metrics.R pull
#   Rscript backfills/backfill_openalex_metrics.R patch

suppressMessages(library(eddyspapersbackend))
Sys.setenv(PAPER_SEARCH_DATA_ROOT = "/Users/ebr/eddyspapers")
config <- get_folder_config(); create_log_file(config)

db_path   <- file.path(config$db_folder, "articles.duckdb")
oa_dir    <- file.path(config$data_root, "openalex")
dir.create(oa_dir, showWarnings = FALSE, recursive = TRUE)
dois_path <- file.path(oa_dir, "corpus_dois.parquet")
meta_dir  <- file.path(oa_dir, "meta")
meta_glob <- file.path(meta_dir, "*.parquet")

route <- commandArgs(trailingOnly = TRUE)[1] %||% "all"

do_dois  <- function() export_corpus_dois(dois_path, db_path)
do_pull  <- function() pull_openalex_metrics(dois_path, meta_dir)
do_patch <- function() {
  m <- openalex_metrics_patch(meta_glob = meta_glob, db_path = db_path)
  info("Wrote article_openalex patch -> ", m)
}

switch(route,
  dois  = do_dois(),
  pull  = do_pull(),
  patch = do_patch(),
  all   = { do_dois(); do_pull(); do_patch() },
  stop("unknown route: ", route))

info("Done (", route, "). Ship: run_backfill() then ./deploy_patches.sh")
