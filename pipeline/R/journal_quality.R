#' Parse a RePEc seriesfactors file
#'
#' The files are informal: prose header, a dashed separator line, then
#' tab-separated rows with 10 documented fields. The parser anchors on the
#' RePEc: handle prefix instead of counting header lines, and hard-fails when
#' the field count shifts — a silently misparsed quality table is worse than a
#' failed stage.
#'
#' @param path Path to a downloaded seriesfactors file
#' @return Tibble with one row per series
#' @export
parse_seriesfactors <- function(path) {
  lines <- readr::read_lines(path)
  data_lines <- stringr::str_subset(lines, "^RePEc:")
  if (length(data_lines) < 1000) {
    stop("seriesfactors parse looks wrong: only ", length(data_lines), " data lines in ", path)
  }

  fields <- stringr::str_split(data_lines, "\t")
  n_fields <- purrr::map_int(fields, length)
  if (!all(n_fields == 10)) {
    stop("seriesfactors format changed: expected 10 tab-separated fields, saw ",
         paste(unique(n_fields[n_fields != 10]), collapse = "/"), " in ", path)
  }

  # series_handle lowercased to match journals.series_handle ("repec:aea:aecrev").
  purrr::map_dfr(fields, ~tibble::tibble(
    series_handle           = tolower(.x[1]),
    n_items                 = suppressWarnings(as.integer(.x[2])),
    simple_if               = suppressWarnings(as.numeric(.x[3])),
    recursive_if            = suppressWarnings(as.numeric(.x[4])),
    discounted_if           = suppressWarnings(as.numeric(.x[5])),
    discounted_recursive_if = suppressWarnings(as.numeric(.x[6])),
    h_index                 = suppressWarnings(as.integer(.x[7])),
    euclid_score            = suppressWarnings(as.numeric(.x[8])),
    series_type             = .x[9],
    series_name             = .x[10]
  )) |>
    dplyr::distinct(series_handle, .keep_all = TRUE)
}

#' Download and populate the journal_quality table
#'
#' Fetches RePEc's series impact factors (all-time + last-10-years variants)
#' and full-replaces journal_quality. Files are cached beside the DB so an
#' unattended run tolerates ideas.repec.org being down — the stage warns and
#' keeps the existing table instead of failing the pipeline.
#'
#' RePEc labels this data experimental and it is methodologically contested
#' (self-citations, no field normalization): treat it as one quality signal
#' among several, never a sole ranking key.
#'
#' @param con DuckDB connection (read-write)
#' @param base_url Base URL for the factor files
#' @param cache_dir Cache folder. Defaults to {data_root}/seriesfactors
#' @return Number of series written (invisibly), or NULL when skipped
#' @export
populate_journal_quality <- function(con,
                                     base_url = "https://ideas.repec.org/top",
                                     cache_dir = NULL) {
  if (is.null(cache_dir)) {
    config <- get_folder_config()
    cache_dir <- file.path(config$data_root, "seriesfactors")
  }
  dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)

  fetch <- function(file_name) {
    dest <- file.path(cache_dir, file_name)
    tryCatch({
      resp <- httr2::request(paste0(base_url, "/", file_name)) |>
        httr2::req_timeout(120) |>
        httr2::req_perform()
      writeBin(httr2::resp_body_raw(resp), dest)
      dest
    }, error = function(e) {
      if (file.exists(dest)) {
        warn("seriesfactors download failed (", conditionMessage(e), ") — using cached ", file_name)
        dest
      } else {
        NULL
      }
    })
  }

  all_path <- fetch("seriesfactors.txt")
  ten_path <- fetch("seriesfactors10.txt")

  if (is.null(all_path)) {
    warn("journal_quality skipped: seriesfactors.txt unavailable and no cache")
    return(invisible(NULL))
  }

  factors <- parse_seriesfactors(all_path)

  if (!is.null(ten_path)) {
    ten <- parse_seriesfactors(ten_path) |>
      dplyr::select(
        series_handle,
        simple_if_10y    = simple_if,
        recursive_if_10y = recursive_if,
        h_index_10y      = h_index
      )
    factors <- dplyr::left_join(factors, ten, by = "series_handle")
  } else {
    factors <- dplyr::mutate(
      factors,
      simple_if_10y = NA_real_, recursive_if_10y = NA_real_, h_index_10y = NA_integer_
    )
  }

  factors <- dplyr::mutate(factors, fetched_at = Sys.time())

  duckdb::duckdb_register(con, "jq_staging", factors)
  on.exit(duckdb::duckdb_unregister(con, "jq_staging"), add = TRUE)
  DBI::dbExecute(con, "CREATE OR REPLACE TABLE journal_quality AS SELECT * FROM jq_staging")

  info("✓ journal_quality: ", nrow(factors), " series")
  invisible(nrow(factors))
}
