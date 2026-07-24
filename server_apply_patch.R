library(eddyspapersbackend)

config <- get_folder_config()
ensure_folders(config)
create_log_file(config)

info("[1] Applying pending patches from ", config$pqt_patch_folder)

applied <- apply_all_patches(
  db_path = file.path(config$db_folder, "articles.duckdb"),
  pqt_patch_folder = config$pqt_patch_folder
)

if (length(applied) == 0) {
  info("Nothing to do — all patches already applied.")
} else {
  info("[2] Recording update time")
  record_db_update_time()
  info("Done. Applied: ", paste(applied, collapse = ", "))
}
