#' Sync the EDIRC institution registry
#'
#' Downloads the edi/inst archive (~16k small ReDIF-Institution files) via the
#' same rsync module as the rest of the pipeline.
#'
#' @param dest_root Root folder for RePEc data. Defaults to config$repec_folder
#' @param rsync_bin Path to rsync binary
#' @return Path to synced folder (invisibly)
#' @export
sync_repec_edirc <- function(dest_root = NULL,
                             rsync_bin = "/opt/homebrew/bin/rsync") {
  if (is.null(dest_root)) {
    config <- get_folder_config()
    dest_root <- config$repec_folder
  }
  if (!file.exists(rsync_bin)) rsync_bin <- "rsync"

  src  <- "rsync.repec.org::RePEc-ReDIF/edi/inst/"
  dest <- file.path(dest_root, "edi", "inst")

  dir.create(dest, recursive = TRUE, showWarnings = FALSE)
  dest <- normalizePath(dest, winslash = "/", mustWork = FALSE)

  withr::with_dir(dest, {
    args <- c("-av", "-s", "--delete", "--contimeout=20", "--timeout=60", src, "./")
    status <- system2(rsync_bin, args)
    if (status != 0) stop("rsync failed with status ", status)
  })

  invisible(dest)
}

cluster_field <- function(cluster, field) {
  if (is.null(cluster) || length(cluster) == 0) return("")
  val <- cluster[[1]][[field]]
  if (is.null(val) || length(val) == 0) return("")
  out <- val[[1]]
  if (is.null(out) || length(out) == 0) "" else out
}

# Prefer the English name where the archive provides one.
cluster_name <- function(cluster) {
  en <- cluster_field(cluster, "name-english")
  if (nchar(en) > 0) en else cluster_field(cluster, "name")
}

#' Extract a country from a free-text Primary-Location
#'
#' EDIRC locations are "City, Country" or "City, State (Country)". Returns ""
#' when the pattern doesn't hold — a wrong country is worse than none.
#'
#' @param location Raw Primary-Location string
#' @return Country string or ""
#' @export
edirc_country <- function(location) {
  loc <- stringr::str_trim(location %||% "")
  if (nchar(loc) == 0) return("")
  paren <- stringr::str_match(loc, "\\(([^()]+)\\)\\s*$")[, 2]
  if (!is.na(paren)) return(stringr::str_trim(paren))
  parts <- stringr::str_split(loc, ",")[[1]]
  if (length(parts) < 2) return("")
  stringr::str_trim(parts[length(parts)])
}

#' Post-process a parsed ReDIF-Institution entry
#'
#' @param entry Parsed entry list from parse_redif_dir.pl
#' @return One-row tibble or NULL if invalid
#' @export
post_process_institution_entry <- function(entry) {
  if (is.null(entry$TYPE) || entry$TYPE != "ReDIF-Institution 1.0") return(NULL)

  edi_handle <- entry$ID %||% ""
  if (!stringr::str_detect(edi_handle, stringr::regex("^repec:edi:", ignore_case = TRUE))) {
    return(NULL)
  }

  primary_name   <- cluster_name(entry$primary)
  secondary_name <- cluster_name(entry$secondary)
  tertiary_name  <- cluster_name(entry$tertiary)

  # Deepest tier is the actual unit authors register under; parent gives context.
  display_name <- if (nchar(tertiary_name) > 0) {
    paste0(tertiary_name, ", ", primary_name)
  } else if (nchar(secondary_name) > 0) {
    paste0(secondary_name, ", ", primary_name)
  } else {
    primary_name
  }

  location <- cluster_field(entry$primary, "location")
  url <- c(
    cluster_field(entry$tertiary, "homepage"),
    cluster_field(entry$secondary, "homepage"),
    cluster_field(entry$primary, "homepage")
  ) |>
    purrr::detect(~nchar(.x) > 0, .default = "")

  # Lowercase like every other cross-table join key (handle_stats, cit_*):
  # pers-archive Workplace-Institution values vary in case across archives.
  tibble::tibble(
    edi_handle     = tolower(edi_handle),
    primary_name   = primary_name,
    secondary_name = secondary_name,
    tertiary_name  = tertiary_name,
    display_name   = display_name,
    location_raw   = location,
    country        = edirc_country(location),
    url            = url
  )
}

#' Parse the EDIRC archive into an institutions tibble
#'
#' @param repec_folder Path to the root RePEc folder. Defaults to config$repec_folder
#' @param script_path Path to parse_redif_dir.pl. Defaults to the bundled script
#' @return Institutions tibble (invisibly)
#' @export
parse_all_institutions <- function(repec_folder = NULL, script_path = NULL) {
  if (is.null(repec_folder)) {
    config <- get_folder_config()
    repec_folder <- config$repec_folder
  }
  if (is.null(script_path)) {
    script_path <- system.file(
      "scripts", "parse_redif_dir.pl",
      package = "eddyspapersbackend"
    )
    if (script_path == "") stop("Could not find parse_redif_dir.pl in package")
  }

  inst_dir <- file.path(repec_folder, "edi", "inst")
  if (!dir.exists(inst_dir)) stop("edi/inst directory not found: ", inst_dir)

  perl_bin <- Sys.which("perl")
  if (perl_bin == "") stop("No perl executable found on PATH")

  info("Parsing EDIRC archive: ", inst_dir)
  res <- processx::run(
    command         = perl_bin,
    args            = c(script_path, inst_dir, "ReDIF-Institution 1.0"),
    error_on_status = TRUE,
    timeout         = 600
  )

  output     <- strsplit(res$stdout, "\n", fixed = TRUE)[[1]]
  json_start <- which(stringr::str_detect(output, "^\\s*\\["))[1]
  json_end   <- utils::tail(which(stringr::str_detect(output, "^\\s*\\]")), 1)
  if (is.na(json_start) || length(json_end) == 0 || json_end < json_start) {
    stop("No valid JSON array in Perl output.\n", res$stderr)
  }

  raw <- jsonlite::fromJSON(
    paste(output[json_start:json_end], collapse = "\n"),
    simplifyVector = FALSE
  )

  institutions <- raw |>
    purrr::map(post_process_institution_entry) |>
    purrr::compact() |>
    purrr::list_rbind()

  if (nrow(institutions) == 0) {
    stop("EDIRC parse yielded 0 institutions from ", inst_dir,
         " — sync missing or parser output changed")
  }

  institutions <- dplyr::distinct(institutions, edi_handle, .keep_all = TRUE)

  info("Parsed ", nrow(institutions), " institutions")
  invisible(institutions)
}

#' Populate the institutions table
#'
#' Full replace on every run (registry is small and authoritative).
#'
#' @param con DuckDB connection (read-write)
#' @param institutions Tibble from parse_all_institutions()
#' @return Number of rows written (invisibly)
#' @export
populate_institutions <- function(con, institutions) {
  duckdb::duckdb_register(con, "institutions_staging", institutions)
  on.exit(duckdb::duckdb_unregister(con, "institutions_staging"), add = TRUE)
  DBI::dbExecute(con, "CREATE OR REPLACE TABLE institutions AS SELECT * FROM institutions_staging")
  info("✓ institutions: ", nrow(institutions), " rows")
  invisible(nrow(institutions))
}
