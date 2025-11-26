library(eddyspapersbackend)

config <- get_folder_config()

message("==== RePEc Update Script ====")
message("Started at: ", Sys.time())
message("Data root: ", config$data_root)

ensure_folders(config)

message("\n[1/4] Syncing RePEc archives...")
tryCatch({
  sync_journals_from_csv(
    journals_csv = config$journals_csv,
    dest_root = config$repec_folder
  )
  message("✓ Sync completed successfully")
}, error = function(e) {
  message("✗ Sync failed: ", e$message)
  stop(e)
})

message("\n[2/4] Parsing ReDIF files...")
tryCatch({
  parse_all_journals(
    repec_folder = config$repec_folder,
    rds_folder = config$rds_folder,
    script_path = "parse_redif_simple.pl",
    skip_today = TRUE
  )
  message("✓ Parsing completed successfully")
}, error = function(e) {
  message("✗ Parsing failed: ", e$message)
  stop(e)
})

message("\n[3/4] Generating embeddings and updating database...")
tryCatch({
  embed_and_populate_db(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    rds_folder = config$rds_folder,
    journals_csv = config$journals_csv,
    batch_size = 50,
    model = "mxbai-embed-large"
  )
  message("✓ Embeddings and database updated successfully")
}, error = function(e) {
  message("✗ Embedding/database update failed: ", e$message)
  stop(e)
})

message("\n[4/4] Creating backup...")
tryCatch({
  pqt_file <- dump_db_to_parquet(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    pqt_folder = config$pqt_folder
  )
  message("✓ Backup created: ", pqt_file)
}, error = function(e) {
  message("⚠ Backup failed (non-fatal): ", e$message)
})

message("\n==== Update Complete ====")
message("Finished at: ", Sys.time())
message("Database: ", file.path(config$db_folder, "articles.duckdb"))
