library(eddyspapersbackend)

# ============================================================================
# Quarterly OpenAlex refresh
# ============================================================================
#
# This is a RECURRING entry point like update_repec.R, but on a *quarterly*
# cadence — OpenAlex ships a fresh CC0 works snapshot to S3 roughly every 3
# months and the metrics we surface (global citation counts, FWCI + percentile,
# retraction flags, OA status, topics) only drift on that timescale. Running it
# weekly would re-scan the ~510M-row snapshot for no new signal.
#
# It refreshes the corpus's `article_openalex` table from the newest snapshot:
#
#   dois   -> re-dump the corpus's distinct DOIs (the corpus grows weekly via
#             update_repec.R, so new papers need metrics)
#   pull   -> scan the newest works snapshot, keep the flat metric columns of
#             rows whose DOI is in the corpus set, into a per-quarter local dir
#             (network-bound, resumable, watchdog-driven)
#   patch  -> rebuild article_openalex (DOI-join, freshest work per DOI) across
#             the union of every pulled quarter, then write + apply the
#             replace_table patch and reset the diff baseline (run_backfill)
#   deploy -> ship the patch to prod (deploy_patches.sh), gated by EDDY_DEPLOY=1
#
# COVERAGE-REGRESSION GUARD (M9 lesson): the snapshot's three giant single-day
# re-dumps (~1000 files each) intermittently stall httpfs; the watchdog GIVES UP
# on a chunk after its retries, so *any* single pull can be missing DOIs that a
# prior pull captured. We therefore pull each quarter into its own timestamped
# dir (meta_<YYYYQn>) and BUILD ACROSS THE UNION of every meta* dir — the
# freshest updated_date wins per DOI, and a stalled chunk this quarter falls
# back to last quarter's row instead of dropping the paper. Never delete old
# meta* dirs; they are the fallback.
#
# Usage (from repo root, on the dev MacBook — the pipeline never runs on prod):
#   Rscript update_openalex.R                 # dois -> pull -> patch (no deploy)
#   EDDY_DEPLOY=1 Rscript update_openalex.R   # ...and ship to prod
#   Rscript update_openalex.R pull            # just resume the network pull
#   Rscript update_openalex.R patch           # rebuild + apply from what's pulled
#   Rscript update_openalex.R deploy          # ship already-applied patches
#
# Schedule (dev crontab), 03:00 on the 1st of Jan/Apr/Jul/Oct:
#   0 3 1 1,4,7,10 * cd /Users/ebr/git_projects/eddyspapers && \
#     EDDY_DEPLOY=1 Rscript update_openalex.R >> ~/eddyspapers/logs/openalex.log 2>&1

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
config <- get_folder_config()
ensure_folders(config)
create_log_file(config)

# Optional server deploy after the run. Off by default; enable with EDDY_DEPLOY=1.
deploy_after <- Sys.getenv("EDDY_DEPLOY", "0") == "1"

deploy_script <- Sys.getenv("EDDY_DEPLOY_SCRIPT", "")
if (deploy_script == "") {
  file_arg <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  base_dir <- if (length(file_arg) == 1) dirname(normalizePath(file_arg)) else getwd()
  deploy_script <- file.path(base_dir, "deploy_patches.sh")
}

route <- commandArgs(trailingOnly = TRUE)[1] %||% "all"

db_path   <- file.path(config$db_folder, "articles.duckdb")
oa_dir    <- file.path(config$data_root, "openalex")
dir.create(oa_dir, showWarnings = FALSE, recursive = TRUE)
dois_path <- file.path(oa_dir, "corpus_dois.parquet")

# This quarter's pull dir (stable across resume within a quarter) and the union
# glob over every quarter ever pulled — the freshest updated_date wins per DOI.
q_num      <- (as.integer(format(Sys.Date(), "%m")) - 1L) %/% 3L + 1L
quarter    <- sprintf("%sQ%d", format(Sys.Date(), "%Y"), q_num)
meta_dir   <- file.path(oa_dir, paste0("meta_", quarter))
union_glob <- file.path(oa_dir, "meta*", "*.parquet")

info("==== OpenAlex Quarterly Update ====")
info("Started at:   ", Sys.time())
info("Data root:    ", config$data_root)
info("Quarter:      ", quarter)
info("Pull dir:     ", meta_dir)
info("Union glob:   ", union_glob)
info("Route:        ", route)

do_dois <- function() {
  info("\n[dois] Exporting corpus DOI set...")
  export_corpus_dois(dois_path, db_path)
  info("✓ Corpus DOIs exported -> ", dois_path)
}

do_pull <- function() {
  info("\n[pull] Scanning newest OpenAlex works snapshot (resumable)...")
  if (!file.exists(dois_path)) {
    stop("Corpus DOI set missing (", dois_path, "); run the 'dois' route first.")
  }
  pull_openalex_metrics(dois_path, meta_dir)
  info("✓ Metrics pull complete -> ", meta_dir)
}

do_patch <- function() {
  info("\n[patch] Rebuilding article_openalex across all pulled quarters...")
  m <- openalex_metrics_patch(meta_glob = union_glob, db_path = db_path)
  info("✓ Wrote article_openalex patch -> ", m)
  info("\n[patch] Applying patch locally + resetting diff baseline...")
  run_backfill(db_path = db_path)
  info("✓ Patch applied and baseline re-dumped")
}

do_deploy <- function() {
  info("\n[deploy] Shipping patch to prod (", deploy_script, ")...")
  if (!deploy_after) {
    info("Skipping server deploy (set EDDY_DEPLOY=1 to enable).")
    info("Deploy manually with: bash ", deploy_script)
    return(invisible())
  }
  if (!file.exists(deploy_script)) stop("deploy script not found: ", deploy_script)
  status <- system2("bash", args = shQuote(deploy_script))
  if (status != 0) stop("deploy_patches.sh exited with status ", status)
  info("✓ Server deploy completed")
}

run_step <- function(name, fn, fatal = TRUE) {
  tryCatch(fn(), error = function(e) {
    info("✗ ", name, " failed: ", e$message)
    if (fatal) stop(e)
  })
}

switch(route,
  dois   = run_step("dois", do_dois),
  pull   = run_step("pull", do_pull),
  patch  = run_step("patch", do_patch),
  deploy = run_step("deploy", do_deploy, fatal = FALSE),
  all    = {
    run_step("dois",   do_dois)
    run_step("pull",   do_pull)
    run_step("patch",  do_patch)
    run_step("deploy", do_deploy, fatal = FALSE)
  },
  stop("unknown route: ", route)
)

info("\n==== OpenAlex Quarterly Update Complete (", route, ") ====")
info("Finished at: ", Sys.time())
if (route %in% c("patch", "all") && !deploy_after) {
  info("Patch built + applied locally. Ship to prod with: EDDY_DEPLOY=1 bash ", deploy_script)
}
