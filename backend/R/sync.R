#' Sync a RePEc archive folder via rsync
#'
#' Downloads or updates a RePEc archive using rsync from rsync.repec.org.
#'
#' @param .archive Archive name (e.g., "oup", "eee")
#' @param .journal Journal code within archive (optional)
#' @param dest_root Root folder for RePEc data. Defaults to config$repec_folder
#' @param rsync_bin Path to rsync binary
#' @return Path to synced folder (invisibly)
#' @export
sync_repec_folder <- function(.archive, .journal = NULL,
                              dest_root = NULL,
                              rsync_bin = "/opt/homebrew/bin/rsync") {
  if (is.null(dest_root)) {
    config <- get_folder_config()
    dest_root <- config$repec_folder
  }
  
  if (is.na(.journal)) .journal <- NULL
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"
  
  module <- if (is.null(.journal))
    sprintf("RePEc-ReDIF/%s/", .archive)
  else
    sprintf("RePEc-ReDIF/%s/%s/", .archive, .journal)
  
  src <- sprintf("rsync.repec.org::%s", module)
  
  dest <- if (is.null(.journal)) file.path(dest_root, .archive)
  else file.path(dest_root, .archive, .journal)
  dir.create(dest, recursive = TRUE, showWarnings = FALSE)
  dest <- normalizePath(dest, winslash = "/", mustWork = FALSE)
  
  withr::with_dir(dest, {
    args <- c("-av", "-s", "--delete", "--contimeout=20", "--exclude=*.pdf", src, "./")
    status <- system2(rsync_bin, args)
    if (status != 0) stop("rsync failed with status ", status)
  })
  
  invisible(dest)
}

#' Sync multiple journals from CSV configuration
#'
#' Reads a journals CSV and syncs all specified archives/journals.
#'
#' @param journals_csv Path to journals CSV file. Defaults to config$journals_csv
#' @param dest_root Root folder for RePEc data. Defaults to config$repec_folder
#' @return Journals data frame (invisibly)
#' @export
sync_journals_from_csv <- function(journals_csv = NULL, dest_root = NULL) {
  if (is.null(journals_csv)) {
    config <- get_folder_config()
    journals_csv <- config$journals_csv
  }
  
  if (is.null(dest_root)) {
    config <- get_folder_config()
    dest_root <- config$repec_folder
  }
  
  if (!file.exists(journals_csv)) {
    stop("Journals CSV not found at: ", journals_csv)
  }
  
  journals <- readr::read_csv(journals_csv, show_col_types = FALSE) |>
    dplyr::select(archive, journal, long_name)
  
  purrr::pwalk(journals, function(archive, journal, long_name) {
    message("Syncing: ", long_name)
    sync_repec_folder(archive, journal, dest_root = dest_root)
  })
  
  invisible(journals)
}
