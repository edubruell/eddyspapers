library(eddyspapersbackend)

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
config <- get_folder_config()
ensure_folders(config)
create_log_file(config)


info("==== RePEc Update Script ====")
info("Started at: ", Sys.time())
info("Data root: ", config$data_root)
iscited_file <- get_folder_refs(config)$repec("cit","conf","iscited.txt") 


info("\n[1/7] Syncing RePEc archives...")
tryCatch({
  sync_journals_from_csv(
    journals_csv = config$journals_csv,
    dest_root = config$repec_folder
  )
  info("✓ Journal Sync completed successfully")
  sync_repec_cpd_conf(
    dest_root = config$repec_folder
  )
  info("✓ CPD/Conf related works Sync completed successfully")
  
  iscited_file <- sync_repec_iscited(dest_root = config$repec_folder)
  info("✓ iscited.txt Sync completed successfully")
}, error = function(e) {
  info("✗ Sync failed: ", e$message)
  stop(e)
})

info("\n[2/7] Parsing ReDIF files...")
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

info("\n[3/7] Generating embeddings and updating database...")
tryCatch({
  embed_and_populate_db(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    rds_folder = config$rds_folder,
    journals_csv = config$journals_csv,
    batch_size = 20,
    model = "mxbai-embed-large"
  )
  info("✓ Embeddings and database updated successfully")
}, error = function(e) {
  info("✗ Embedding/database update failed: ", e$message)
  stop(e)
})

info("\n[4/7] Creating Related Works Table in Database...")
tryCatch({
  write_version_links_to_db(
        db_path = file.path(config$db_folder, "articles.duckdb"),
        rw_file = get_folder_refs(config)$repec("cpd","conf","relatedworks.dat")
        )
  info("✓ Related Works table created successfully")
}, error = function(e) {
  info("✗ Related Works Parsing failed: ", e$message)
  stop(e)
})

info("\n[5/7] Processing citation data...")
tryCatch({
  info("  Populating citation tables...")
  cit_result <- populate_citations(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    iscited_file = iscited_file
  )
  
  info("✓ Citation processing completed")
  info("  Total citation edges: ", cit_result$total_edges)
  info("  Internal citation edges: ", cit_result$internal_edges)
}, error = function(e) {
  info("✗ Citation processing failed: ", e$message)
  stop(e)
})


info("\n[6/7] Computing handle statistics...")
tryCatch({
  con <- DBI::dbConnect(
    duckdb::duckdb(),
    dbdir = file.path(config$db_folder, "articles.duckdb")
  )
  
  stats_count <- compute_handle_stats(con)
  
  DBI::dbDisconnect(con)
  
  info("✓ Handle statistics computed successfully")
  info("  Handles processed: ", stats_count)
}, error = function(e) {
  info("✗ Handle statistics computation failed: ", e$message)
  stop(e)
})

info("\n[7/7] Creating backup...")
tryCatch({
  pqt_file <- dump_db_to_parquet(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    pqt_folder = config$pqt_folder
  )
  info("✓ Backup created: ", pqt_file)
}, error = function(e) {
  info("⚠ Backup failed (non-fatal): ", e$message)
})

info("Changing update time record")
record_db_update_time()
info("✓ update time record changed")


info("\n==== Update Complete ====")
info("Finished at: ", Sys.time())
info("Database: ", file.path(config$db_folder, "articles.duckdb"))

info("\n==== Create Diffs for server sync ====")

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
