library(eddyspapersbackend)

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
config <- get_folder_config()
ensure_folders(config)
create_log_file(config)


info("==== RePEc Update Script ====")
info("Started at: ", Sys.time())
info("Data root: ", config$data_root)


info("\n[1/4] Syncing RePEc archives...")
tryCatch({
  sync_journals_from_csv(
    journals_csv = config$journals_csv,
    dest_root = config$repec_folder
  )
  info("✓ Sync completed successfully")
}, error = function(e) {
  info("✗ Sync failed: ", e$message)
  stop(e)
})

info("\n[2/4] Parsing ReDIF files...")
tryCatch({
  parse_all_journals(
    repec_folder = config$repec_folder,
    rds_folder = config$rds_folder,
    skip_today = TRUE
  )
  info("✓ Parsing completed successfully")
}, error = function(e) {
  info("✗ Parsing failed: ", e$message)
  stop(e)
})

info("\n[3/4] Generating embeddings and updating database...")
tryCatch({
  embed_and_populate_db(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    rds_folder = config$rds_folder,
    journals_csv = config$journals_csv,
    batch_size = 50,
    model = "mxbai-embed-large"
  )
  info("✓ Embeddings and database updated successfully")
}, error = function(e) {
  info("✗ Embedding/database update failed: ", e$message)
  stop(e)
})

info("\n[4/4] Creating backup...")
tryCatch({
  pqt_file <- dump_db_to_parquet(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    pqt_folder = config$pqt_folder
  )
  info("✓ Backup created: ", pqt_file)
}, error = function(e) {
  info("⚠ Backup failed (non-fatal): ", e$message)
})

info("\n==== Update Complete ====")
info("Finished at: ", Sys.time())
info("Database: ", file.path(config$db_folder, "articles.duckdb"))
