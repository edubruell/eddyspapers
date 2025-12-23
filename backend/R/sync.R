#' List files in a RePEc archive or journal via rsync
#'
#' Shows remote file listings from rsync.repec.org without downloading anything.
#'
#' @param .archive Archive name (for example "oup", "eee")
#' @param .journal Optional journal code within the archive
#' @param rsync_bin Path to rsync binary
#' @return Character vector with the listing (invisible)
#' @export
list_repec_folder <- function(.archive,
                              .journal = NULL,
                              rsync_bin = "/opt/homebrew/bin/rsync") {
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"
  
  module <- if (is.null(.journal))
    sprintf("RePEc-ReDIF/%s", .archive)
  else
    sprintf("RePEc-ReDIF/%s/%s", .archive, .journal)
  
  # Append slash only to request directory contents
  src <- sprintf("rsync.repec.org::%s/", module)
  
  args <- c("--list-only", "-s", src)
  
  out <- system2(rsync_bin, args, stdout = TRUE, stderr = TRUE)
  out
}



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
    info("Syncing: ", long_name)
    sync_repec_folder(archive, journal, dest_root = dest_root)
  })
  
  invisible(journals)
}


#' Sync RePEc CPD conf papers
#'
#' Downloads or updates related works data using rsync from rsync.repec.org.
#'
#' @param dest_root Root folder for RePEc data. Defaults to here::here("RePEc")
#' @param rsync_bin Path to rsync binary
#' @return Path to synced folder (invisibly)
#' @export
sync_repec_cpd_conf <- function(
    dest_root = here::here("RePEc"),
    rsync_bin = "/opt/homebrew/bin/rsync"
) {
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"
  
  src  <- "rsync.repec.org::RePEc-ReDIF/cpd/conf/"
  dest <- file.path(dest_root, "cpd", "conf")
  
  dir.create(dest, recursive = TRUE, showWarnings = FALSE)
  dest <- normalizePath(dest, winslash = "/", mustWork = FALSE)
  
  withr::with_dir(dest, {
    args <- c("-av", "-s", "--delete", "--contimeout=20", src, "./")
    status <- system2(rsync_bin, args)
    if (status != 0) stop("rsync failed with status ", status)
  })
  
  invisible(dest)
}


#' Sync RePEc citation data (iscited)
#'
#' Downloads or updates the iscited.txt.gz file containing citation data from RePEc.
#' Automatically decompresses the file after download.
#'
#' @param dest_root Root folder for RePEc data. Defaults to here::here("RePEc")
#' @param rsync_bin Path to rsync binary
#' @return Path to decompressed iscited.txt file (invisibly)
#' @export
sync_repec_iscited <- function(
    dest_root = here::here("RePEc"),
    rsync_bin = "/opt/homebrew/bin/rsync"
) {
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"
  
  src_base <- "rsync.repec.org::RePEc-ReDIF/cit/conf/"
  file_name <- "iscited.txt.gz"
  
  dest_dir <- file.path(dest_root, "cit", "conf")
  dir.create(dest_dir, recursive = TRUE, showWarnings = FALSE)
  dest_dir <- normalizePath(dest_dir, winslash = "/", mustWork = FALSE)
  
  src  <- file.path(src_base, file_name)
  dest <- file.path(dest_dir, file_name)
  
  args <- c("-av", "-s", src, dest)
  status <- system2(rsync_bin, args)
  if (status != 0) stop("rsync failed with status ", status)
  
  info("Downloaded: ", dest)
  
  decompressed_path <- sub("\\.gz$", "", dest)
  R.utils::gunzip(dest, destname = decompressed_path, overwrite = TRUE, remove = FALSE)
  
  info("Decompressed: ", decompressed_path)
  
  invisible(decompressed_path)
}

#' Sync RePEc author identification data (pers archive)
#'
#' Downloads or updates the RePEc person (pers) archive, which contains
#' author identifiers and metadata in RDF format.
#'
#' @param dest_root Root folder for RePEc data. Defaults to config$repec_folder
#' @param rsync_bin Path to rsync binary
#' @return Path to synced pers folder (invisibly)
#' @export
sync_repec_pers <- function(dest_root = NULL,
                            rsync_bin = "/opt/homebrew/bin/rsync") {
  if (is.null(dest_root)) {
    config <- get_folder_config()
    dest_root <- config$repec_folder
  }
  
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"
  
  src  <- "rsync.repec.org::RePEc-ReDIF/per/pers/"
  dest <- file.path(dest_root, "per", "pers")
  
  dir.create(dest, recursive = TRUE, showWarnings = FALSE)
  dest <- normalizePath(dest, winslash = "/", mustWork = FALSE)
  
  withr::with_dir(dest, {
    args <- c(
      "-av",
      "-s",
      "--delete",
      "--contimeout=20",
      src,
      "./"
    )
    status <- system2(rsync_bin, args)
    if (status != 0) stop("rsync failed with status ", status)
  })
  
  invisible(dest)
}

