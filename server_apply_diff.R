library(rlang)
library(eddyspapersbackend)

config <- get_folder_config()
ensure_folders(config)
create_log_file(config)

info("[1] Locating newest parquet diff in ", config$pqt_diff_folder)

diff_files <- list.files(
  config$pqt_diff_folder,
  pattern = "^articles_diff_\\d{8}_\\d{6}_\\d{8}_\\d{6}\\.parquet$"
)

if (length(diff_files) == 0) {
  stop("No articles_diff_*.parquet files found in ", config$pqt_diff_folder)
}

stamp_pairs <- stringr::str_match(
  diff_files,
  "^articles_diff_(\\d{8}_\\d{6})_(\\d{8}_\\d{6})\\.parquet$"
)

update_stamps <- stamp_pairs[, 3]
newest        <- which(update_stamps == max(update_stamps))[1]
base_stamp    <- stamp_pairs[newest, 2]
update_stamp  <- stamp_pairs[newest, 3]

info("  Base:   ", base_stamp)
info("  Update: ", update_stamp)

tables <- c("articles", "handle_stats", "cit_all", "cit_internal", "version_links")
expected <- file.path(
  config$pqt_diff_folder,
  sprintf("%s_diff_%s_%s.parquet", tables, base_stamp, update_stamp)
)
missing <- expected[!file.exists(expected)]
if (length(missing) > 0) {
  stop(
    "Missing diff files for newest stamp pair:\n  ",
    paste(basename(missing), collapse = "\n  ")
  )
}

info("[2] Apply diffs to database...")
results <- apply_parquet_diffs(
  base_stamp = base_stamp,
  update_stamp = update_stamp,
  pqt_diff_folder = config$pqt_diff_folder
)

info("[3] Recording update time")
record_db_update_time()
info("Done. Applied diff ", base_stamp, " -> ", update_stamp)
