library(eddyspapersbackend)

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
  deploy_script <- file.path(base_dir, "deploy_diffs.sh")
}


info("==== RePEc Update Script ====")
info("Started at: ", Sys.time())
info("Data root: ", config$data_root)
iscited_file <- get_folder_refs(config)$repec("cit","conf","iscited.txt") 


info("\n[1/14] Syncing RePEc archives...")
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

  sync_repec_edirc(dest_root = config$repec_folder)
  info("✓ EDIRC institution Sync completed successfully")
}, error = function(e) {
  info("✗ Sync failed: ", e$message)
  stop(e)
})

info("\n[2/14] Parsing ReDIF files...")
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

info("\n[3/14] Generating embeddings and updating database...")
tryCatch({
  embed_and_populate_db(
    db_path = file.path(config$db_folder, "articles.duckdb"),
    rds_folder = config$rds_folder,
    journals_csv = config$journals_csv,
    batch_size = 20,
    model = "mxbai-embed-large"
  )
  con_j <- get_db_con(file.path(config$db_folder, "articles.duckdb"))
  populate_journals_table(con_j, journals_csv = config$journals_csv)
  DBI::dbDisconnect(con_j)
  info("✓ Embeddings and database updated successfully")
}, error = function(e) {
  info("✗ Embedding/database update failed: ", e$message)
  stop(e)
})

info("\n[4/14] Populating JEL tables...")
tryCatch({
  con_jel <- get_db_con(file.path(config$db_folder, "articles.duckdb"))
  build_article_jel(con_jel, rds_folder = config$rds_folder)
  populate_jel_codes(con_jel)
  info("✓ JEL tables populated successfully")
}, error = function(e) {
  info("⚠ JEL population failed (non-fatal): ", e$message)
}, finally = {
  if (exists("con_jel")) try(DBI::dbDisconnect(con_jel, shutdown = TRUE), silent = TRUE)
})

info("\n[5/14] Creating Related Works Table in Database...")
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

info("\n[6/14] Processing citation data...")
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


info("\n[7/14] Computing handle statistics...")
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

info("\n[8/14] Syncing pers author archive...")
tryCatch({
  sync_repec_pers(dest_root = config$repec_folder)
  info("✓ Pers sync completed successfully")
}, error = function(e) {
  info("⚠ Pers sync failed (non-fatal): ", e$message)
})

info("\n[9/14] Parsing person RDF files...")
tryCatch({
  parse_all_persons(
    repec_folder       = config$repec_folder,
    rds_persons_folder = config$rds_persons_folder
  )
  info("✓ Person parsing completed successfully")
}, error = function(e) {
  info("⚠ Person parsing failed (non-fatal): ", e$message)
})

info("\n[10/14] Populating person tables and computing stats...")
tryCatch({
  populate_persons(
    db_path            = file.path(config$db_folder, "articles.duckdb"),
    rds_persons_folder = config$rds_persons_folder
  )
  con <- get_db_con(file.path(config$db_folder, "articles.duckdb"))
  person_count <- compute_person_stats(con)
  DBI::dbDisconnect(con)
  info("✓ Person tables populated; stats computed for ", person_count, " persons")
}, error = function(e) {
  info("⚠ Person table population failed (non-fatal): ", e$message)
})

info("\n[11/14] Populating EDIRC institutions...")
tryCatch({
  institutions <- parse_all_institutions(repec_folder = config$repec_folder)
  con_edi <- get_db_con(file.path(config$db_folder, "articles.duckdb"))
  migrate_schema(con_edi)
  populate_institutions(con_edi, institutions)
  info("✓ institutions table populated successfully")
}, error = function(e) {
  info("⚠ EDIRC population failed (non-fatal): ", e$message)
}, finally = {
  if (exists("con_edi")) try(DBI::dbDisconnect(con_edi, shutdown = TRUE), silent = TRUE)
})

info("\n[12/14] Syncing Wikidata enrichment for persons...")
tryCatch({
  wikidata_count <- sync_wikidata_persons(
    db_path = file.path(config$db_folder, "articles.duckdb")
  )
  info("✓ Wikidata sync completed for ", wikidata_count, " persons")
}, error = function(e) {
  info("⚠ Wikidata sync failed (non-fatal): ", e$message)
})

info("\n[13/14] Refreshing journal quality factors...")
tryCatch({
  con_jq <- get_db_con(file.path(config$db_folder, "articles.duckdb"))
  migrate_schema(con_jq)
  populate_journal_quality(con_jq)
  info("✓ journal_quality refreshed successfully")
}, error = function(e) {
  info("⚠ journal_quality refresh failed (non-fatal): ", e$message)
}, finally = {
  if (exists("con_jq")) try(DBI::dbDisconnect(con_jq, shutdown = TRUE), silent = TRUE)
})

info("\n[14/14] Creating backup...")
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

info("\n==== Refresh agentic DB copy (atomic swap) ====")
tryCatch({
  src     <- file.path(config$db_folder, "articles.duckdb")
  dst     <- file.path(config$db_folder, "articles_agentic.duckdb")
  dst_new <- paste0(dst, ".new")

  # Checkpoint the source into a single self-contained file (no outstanding WAL) so the copy
  # is one file and the swap is a single atomic rename — the Hono service (opened read-only)
  # always sees either the old or the new snapshot whole, never a torn duckdb/wal pair.
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = src, read_only = FALSE)
  DBI::dbExecute(con, "CHECKPOINT")
  DBI::dbDisconnect(con, shutdown = TRUE)

  if (file.exists(dst_new)) file.remove(dst_new)
  file.copy(src, dst_new)
  file.rename(dst_new, dst)                 # atomic on the same filesystem

  stale_wal <- paste0(dst, ".wal")          # a stale WAL would shadow the freshly-swapped file
  if (file.exists(stale_wal)) file.remove(stale_wal)

  info("✓ Agentic copy refreshed (atomic): ", dst)
}, error = function(e) {
  info("⚠ Agentic DB copy failed (non-fatal): ", e$message)
})

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


info("\n==== Deploy diffs to server ====")
if (deploy_after) {
  tryCatch({
    if (!file.exists(deploy_script)) {
      stop("deploy script not found: ", deploy_script)
    }
    info("Running ", deploy_script)
    status <- system2("bash", args = shQuote(deploy_script))
    if (status != 0) {
      stop("deploy_diffs.sh exited with status ", status)
    }
    info("✓ Server deploy completed")
  }, error = function(e) {
    info("⚠ Server deploy failed (non-fatal): ", e$message)
  })
} else {
  info("Skipping server deploy (set EDDY_DEPLOY=1 to enable).")
  info("Deploy manually with: bash ", deploy_script)
}
