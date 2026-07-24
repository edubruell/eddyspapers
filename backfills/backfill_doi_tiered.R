#!/usr/bin/env Rscript
# Tiered DOI backfill runner (M8 follow-up). Replaces the blind Crossref route.
#
#   Route 1 (Nature):     nature.com/articles/<id> -> 10.1038/<id>, verified.
#   Route 2 (Container):  publisher journals via container-title Crossref query.
#
# Both are resumable (per-tier state parquet). Run either standalone or both.
# After the runs finish, call finalize_doi_patch() to fold every source
# (incl. the interrupted blind run's 571 hits) into ONE update_columns patch,
# then follow the baseline-reset rule: apply_all_patches -> dump_db_to_parquet
# -> deploy_patches.sh.
#
# Usage (from repo root):
#   Rscript backfills/backfill_doi_tiered.R nature      # Route 1 only (full)
#   Rscript backfills/backfill_doi_tiered.R container   # Route 2 only (full)
#   Rscript backfills/backfill_doi_tiered.R finalize    # build the combined patch

suppressMessages(library(eddyspapersbackend))
Sys.setenv(PAPER_SEARCH_DATA_ROOT = "/Users/ebr/eddyspapers")
config <- get_folder_config(); create_log_file(config)

mailto  <- "eduard.bruell@zew.de"
db_path <- file.path(config$db_folder, "articles.duckdb")
route   <- commandArgs(trailingOnly = TRUE)[1] %||% "nature"

# Both routes now run against OpenAlex (Crossref's search endpoint is rate-limit
# capped — see 04_tiered_doi.md). Nature batch-verifies transforms by DOI;
# container does OpenAlex title+year search via the shared parallel engine.
# Override container concurrency with an optional 2nd arg.
ma_arg <- commandArgs(trailingOnly = TRUE)[2]
ma <- function(default) if (length(ma_arg) == 0 || is.na(ma_arg)) default else as.integer(ma_arg)

if (route == "nature") {
  res <- nature_backfill_openalex(db_path = db_path, mailto = mailto, limit = Inf, min_sim = 0.4)
  cat("nature verified:", sum(!is.na(res$doi)), "/", nrow(res), "\n")
} else if (route == "container") {
  res <- container_backfill_openalex(db_path = db_path, mailto = mailto, limit = Inf, min_sim = 0.5,
                                     max_active = ma(4L))
  cat("container matched:", sum(!is.na(res$doi)), "/", nrow(res), "\n")
} else if (route == "finalize") {
  m <- finalize_doi_patch(db_path = db_path)
  cat("patch manifest:", m %||% "(nothing to patch)", "\n")
} else {
  stop("unknown route: ", route)
}
