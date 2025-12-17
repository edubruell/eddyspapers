library(eddyspapersbackend)
devtools::load_all("backend")

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
config <- get_folder_config()
ensure_folders(config)
create_log_file(config)

info("==== Parquet Diff Demo ====")


info("\n[1] List available parquet dumps:")
pqt_files <- list.files(config$pqt_folder, pattern = "^articles_.*\\.parquet$")
info("Available dumps: ", paste(pqt_files, collapse = ", "))

if (length(pqt_files) < 2) {
  stop("Need at least 2 parquet dumps to compute diffs. Run update_repec.R twice.")
}


stamps <- sub("^articles_(.*)\\.parquet$", "\\1", pqt_files)
stamps <- sort(stamps)
base_stamp <- stamps[length(stamps) - 1]
update_stamp <- stamps[length(stamps)]

info("\nComparing:")
info("  Base:   ", base_stamp)
info("  Update: ", update_stamp)


info("\n[2] Computing diffs...")
diff_files <- compute_parquet_diffs(
  base_stamp = base_stamp,
  update_stamp = update_stamp,
  pqt_folder = config$pqt_folder,
  pqt_diff_folder = config$pqt_diff_folder
)

info("\n[3] Diff files created:")
for (tbl in names(diff_files)) {
  info("  ", tbl, ": ", diff_files[[tbl]])
}


info("\n[4] Apply diffs to a test database...")
info("NOTE: This would apply changes to your database.")
info("Uncomment the code below to actually apply:")
info("")
info("test_db <- file.path(config$db_folder, 'articles_test.duckdb')")
info("file.copy(")
info("  file.path(config$db_folder, 'articles.duckdb'),")
info("  test_db")
info(")")
info("")
info("results <- apply_parquet_diffs(")
info("  base_stamp = base_stamp,")
info("  update_stamp = update_stamp,")
info("  db_path = test_db,")
info("  pqt_diff_folder = config$pqt_diff_folder")
info(")")

info("\n==== Demo Complete ====")

devtools::install_github("edubruell/eddyspapers",subdir="backend")

devtools::document("backend")