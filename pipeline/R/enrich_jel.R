#' Build the article_jel table from the parsed RDS cache
#'
#' JEL codes are already extracted at parse time (jel_list) — this unnests
#' them into article_jel(handle, jel_code). Handles are stored LOWERCASE like
#' handle_stats/cit_internal so API-side joins use LOWER(a.Handle) uniformly.
#'
#' Coverage caveat (measured 2026-07-23): ~55% of the corpus overall, 71% of
#' WP series but only 43% of journal articles and 0% of arXiv — absence of
#' rows means UNKNOWN, never "not this field". Any jel filter must be built
#' as an opt-in restriction, not a facet with a "none" bucket.
#'
#' @param con DuckDB connection (read-write)
#' @param rds_folder Path to RDS files. Defaults to config$rds_folder
#' @return Number of (handle, jel_code) rows written (invisibly)
#' @export
build_article_jel <- function(con, rds_folder = NULL) {
  if (is.null(rds_folder)) {
    config <- get_folder_config()
    rds_folder <- config$rds_folder
  }

  jel_raw <- list.files(rds_folder, full.names = TRUE) |>
    purrr::map(function(f) {
      d <- readRDS(f)
      if (!all(c("Handle", "jel_list") %in% colnames(d))) return(NULL)
      dplyr::select(d, Handle, jel_list)
    }) |>
    purrr::compact() |>
    purrr::list_rbind()

  if (nrow(jel_raw) == 0) {
    stop("No RDS file in ", rds_folder, " carries a jel_list column — parse cache missing or stale")
  }

  jel_long <- jel_raw |>
    tidyr::unnest(jel_list) |>
    dplyr::transmute(
      handle   = tolower(Handle),
      jel_code = toupper(stringr::str_trim(jel_list))
    ) |>
    dplyr::filter(stringr::str_detect(jel_code, "^[A-Z]\\d{0,2}$")) |>
    dplyr::distinct(handle, jel_code)

  corpus_handles <- DBI::dbGetQuery(
    con, "SELECT LOWER(Handle) AS handle FROM articles"
  ) |>
    tibble::as_tibble()

  jel_corpus <- dplyr::semi_join(jel_long, corpus_handles, by = "handle")

  duckdb::duckdb_register(con, "jel_staging", jel_corpus)
  on.exit(duckdb::duckdb_unregister(con, "jel_staging"), add = TRUE)
  DBI::dbExecute(con, "CREATE OR REPLACE TABLE article_jel AS SELECT * FROM jel_staging")
  migrate_schema(con)

  n_handles <- dplyr::n_distinct(jel_corpus$handle)
  info("✓ article_jel: ", nrow(jel_corpus), " rows across ", n_handles, " papers")
  invisible(nrow(jel_corpus))
}

#' Populate the jel_codes lookup from the AEA classification tree
#'
#' Downloads (or reads a cached copy of) the official AEA JEL XML and writes
#' the full 3-level hierarchy. The file is cached beside the DB so unattended
#' runs tolerate aeaweb.org being down — a stale lookup beats a failed run.
#'
#' @param con DuckDB connection (read-write)
#' @param xml_url Source URL for classificationTree.xml
#' @param cache_path Local cache path. Defaults to {data_root}/jel_classification.xml
#' @return Number of codes written (invisibly)
#' @export
populate_jel_codes <- function(con,
                               xml_url = "https://www.aeaweb.org/econlit/classificationTree.xml",
                               cache_path = NULL) {
  if (is.null(cache_path)) {
    config <- get_folder_config()
    cache_path <- file.path(config$data_root, "jel_classification.xml")
  }

  # Download to a temp path and only promote it to the cache AFTER the parse
  # validates — a 200-status garbage page must not destroy the last good cache.
  fetched_path <- tempfile(fileext = ".xml")
  fetched <- tryCatch({
    resp <- httr2::request(xml_url) |>
      httr2::req_timeout(60) |>
      httr2::req_perform()
    writeBin(httr2::resp_body_raw(resp), fetched_path)
    TRUE
  }, error = function(e) {
    warn("JEL XML download failed (", conditionMessage(e), ") — using cache if present")
    FALSE
  })

  source_path <- if (fetched) fetched_path else cache_path
  if (!file.exists(source_path)) {
    stop("No JEL classification XML available (download failed, no cache)")
  }

  doc <- xml2::read_xml(source_path)
  nodes <- xml2::xml_find_all(doc, "//classification")

  codes <- purrr::map_dfr(nodes, function(n) {
    parent_node <- xml2::xml_parent(n)
    parent_code <- if (xml2::xml_name(parent_node) == "classification") {
      xml2::xml_text(xml2::xml_find_first(parent_node, "./code"))
    } else {
      NA_character_
    }
    tibble::tibble(
      code   = xml2::xml_text(xml2::xml_find_first(n, "./code")),
      label  = xml2::xml_text(xml2::xml_find_first(n, "./description")),
      level  = as.integer(xml2::xml_attr(n, "level")),
      parent = parent_code
    )
  }) |>
    dplyr::mutate(label = stringr::str_replace_all(label, "\\s*&bull;\\s*", " • ")) |>
    dplyr::distinct(code, .keep_all = TRUE)

  if (nrow(codes) < 500) {
    stop("JEL classification parse looks wrong: only ", nrow(codes), " codes")
  }

  if (fetched) file.copy(fetched_path, cache_path, overwrite = TRUE)

  duckdb::duckdb_register(con, "jel_codes_staging", codes)
  on.exit(duckdb::duckdb_unregister(con, "jel_codes_staging"), add = TRUE)
  DBI::dbExecute(con, "CREATE OR REPLACE TABLE jel_codes AS SELECT * FROM jel_codes_staging")

  info("✓ jel_codes: ", nrow(codes), " codes (source ",
       if (fetched) "fresh download" else "cache", ")")
  invisible(nrow(codes))
}
