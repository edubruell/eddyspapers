library(eddyspapersbackend)

config <- get_folder_config()
ensure_folders(config)
create_log_file(config)


info("\n[1] List available parquet dumps:")
pqt_files <- list.files(config$pqt_folder, pattern = "^articles_.*\\.parquet$")
info("Available dumps: ", paste(pqt_files, collapse = ", "))


stamps <- sub("^articles_(.*)\\.parquet$", "\\1", pqt_files)
stamps <- sort(stamps)
base_stamp <- stamps[length(stamps) - 1]
update_stamp <- stamps[length(stamps)]

info("\nComparing:")
info("  Base:   ", base_stamp)
info("  Update: ", update_stamp)

info("\n[2] Apply diffs to a test database...")

results <- apply_parquet_diffs(
  base_stamp = base_stamp,
  update_stamp = update_stamp,
  pqt_diff_folder = config$pqt_diff_folder
)

