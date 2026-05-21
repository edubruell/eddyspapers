library(rlang)
library(eddyspapersbackend)

config <- get_folder_config()
ensure_folders(config)
create_log_file(config)
config$pqt_diff_folder

info("\n[1] List available parquet dumps:")
pqt_diffs <- list.files(config$pqt_diff_folder, pattern = "^articles_.*\\.parquet$")
info("Available dumps: ", paste(pqt_diffs, collapse = ", "))


stamps <- sub("^articles_(.*)\\.parquet$", "\\1", pqt_files)
stamps <- sort(stamps)
base_stamp <- stamps[length(stamps) - 1]
update_stamp <- stamps[length(stamps)]

info("\nComparing:")
info("  Base:   ", base_stamp)
info("  Update: ", update_stamp)

info("\n[2] Apply diffs to a database...")

results <- apply_parquet_diffs(
  base_stamp = base_stamp,
  update_stamp = update_stamp,
  pqt_diff_folder = config$pqt_diff_folder
)

info("[3] Changing update time record")
record_db_update_time()
info("✓ update time record changed")

