#' Get folder configuration
#'
#' Returns a list of configured folder paths for the paper search system.
#' Paths can be customized via environment variables. If PAPER_SEARCH_DATA_ROOT is set,
#' it provides defaults for all folders. Individual folders can be overridden with
#' specific environment variables.
#'
#' Environment variables:
#' - PAPER_SEARCH_DATA_ROOT: Base directory (default: ./data)
#' - PAPER_SEARCH_REPEC: RePEc folder (default: {data_root}/RePEc)
#' - PAPER_SEARCH_RDS: RDS folder (default: {data_root}/rds_archivep)
#' - PAPER_SEARCH_PQT: Parquet folder (default: {data_root}/pqt)
#' - PAPER_SEARCH_PQT_DIFF: Parquet diff folder (default: {data_root}/pqt_diff)
#' - PAPER_SEARCH_DB: Database folder (default: {data_root}/db)
#' - PAPER_SEARCH_JOURNALS_CSV: Journals CSV file (default: {data_root}/journals.csv)
#'
#' @return A list with paths for data_root, repec_folder, rds_folder, pqt_folder,
#'   pqt_diff_folder, db_folder, and journals_csv
#' @param data_root Root folder for the data
#'  
#' @export
get_folder_config <- function(data_root = Sys.getenv("PAPER_SEARCH_DATA_ROOT", 
                                                     unset = file.path(here::here(), "data"))) {
  
  list(
    data_root = data_root,
    repec_folder = Sys.getenv("PAPER_SEARCH_REPEC", 
                              unset = file.path(data_root, "RePEc")),
    rds_folder = Sys.getenv("PAPER_SEARCH_RDS", 
                            unset = file.path(data_root, "rds_archivep")),
    pqt_folder = Sys.getenv("PAPER_SEARCH_PQT", 
                            unset = file.path(data_root, "pqt")),
    pqt_diff_folder = Sys.getenv("PAPER_SEARCH_PQT_DIFF", 
                                 unset = file.path(data_root, "pqt_diff")),
    db_folder = Sys.getenv("PAPER_SEARCH_DB", 
                           unset = file.path(data_root, "db")),
    logs      = Sys.getenv("PAPER_SEARCH_JOURNALS_CSV", 
                              unset = file.path(data_root, "logs")),
    journals_csv = Sys.getenv("PAPER_SEARCH_LOGS", 
                              unset = file.path(data_root, "journals.csv"))
  )
}

#' Ensure required folders exist
#'
#' Creates all necessary folders for the paper search system if they don't exist.
#'
#' @param config Optional config list from get_folder_config(). If NULL, will call
#'   get_folder_config() internally.
#' @return The config list (invisibly)
#' @export
ensure_folders <- function(config = NULL) {
  if (is.null(config)) {
    config <- get_folder_config()
  }
  
  folders <- c(
    config$data_root,
    config$repec_folder,
    config$rds_folder,
    config$pqt_folder,
    config$pqt_diff_folder,
    config$db_folder,
    config$logs
  )
  
  for (folder in folders) {
    if (!dir.exists(folder)) {
      dir.create(folder, recursive = TRUE, showWarnings = FALSE)
      message("Created folder: ", folder)
    }
  }
  
  invisible(config)
}
