get_folder_config <- function() {
  project_root <- here::here()
  
  data_root <- Sys.getenv("PAPER_SEARCH_DATA_ROOT", 
                          unset = file.path(project_root, "data"))
  
  list(
    data_root = data_root,
    repec_folder = file.path(data_root, "RePEc"),
    rds_folder = file.path(data_root, "rds_archivep"),
    pqt_folder = file.path(data_root, "pqt"),
    db_folder = file.path(data_root, "db"),
    journals_csv = file.path(data_root, "journals.csv")
  )
}

ensure_folders <- function(config = NULL) {
  if (is.null(config)) {
    config <- get_folder_config()
  }
  
  folders <- c(
    config$data_root,
    config$repec_folder,
    config$rds_folder,
    config$pqt_folder,
    config$db_folder
  )
  
  for (folder in folders) {
    if (!dir.exists(folder)) {
      dir.create(folder, recursive = TRUE, showWarnings = FALSE)
      message("Created folder: ", folder)
    }
  }
  
  invisible(config)
}
