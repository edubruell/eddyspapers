#' Normalize DOI strings
#'
#' ReDIF doi fields arrive as bare DOIs, resolver URLs, or with stray
#' punctuation. Returns lowercase bare DOIs (10.xxxx/...) or NA for anything
#' that doesn't validate — a wrong DOI is worse than a missing one.
#'
#' @param x Character vector of raw DOI candidates
#' @return Character vector of normalized DOIs (NA where invalid)
#' @export
normalize_doi <- function(x) {
  cleaned <- x |>
    stringr::str_trim() |>
    stringr::str_remove("^(https?://)?(dx\\.)?doi\\.org/") |>
    stringr::str_remove(stringr::regex("^doi:\\s*", ignore_case = TRUE)) |>
    stringr::str_remove("[[:punct:]]+$") |>
    tolower()
  dplyr::if_else(
    stringr::str_detect(cleaned, "^10\\.\\d{4,9}/\\S+$"),
    cleaned,
    NA_character_
  )
}

#' Extract DOIs from the parsed RDS cache
#'
#' Reads every RDS in the parse cache and returns Handle + normalized DOI for
#' rows that carry one. This is the authoritative source (doi_source 'redif').
#'
#' @param rds_folder Path to RDS files. Defaults to config$rds_folder
#' @return Tibble (Handle, doi, doi_source)
#' @export
extract_dois_from_rds <- function(rds_folder = NULL) {
  if (is.null(rds_folder)) {
    config <- get_folder_config()
    rds_folder <- config$rds_folder
  }

  proto <- tibble::tibble(Handle = character(), doi = character())
  list.files(rds_folder, full.names = TRUE) |>
    purrr::map(function(f) {
      d <- readRDS(f)
      if (!"doi" %in% colnames(d)) return(NULL)
      dplyr::select(d, Handle, doi)
    }) |>
    purrr::compact() |>
    purrr::list_rbind(ptype = proto) |>
    dplyr::mutate(doi = normalize_doi(doi)) |>
    dplyr::filter(!is.na(doi)) |>
    dplyr::distinct(Handle, .keep_all = TRUE) |>
    dplyr::mutate(doi_source = "redif")
}

#' Extract DOIs from the articles url column
#'
#' Many publisher URLs embed the DOI (doi.org resolvers, Elsevier /pii is NOT
#' a DOI and is ignored). Secondary source (doi_source 'url').
#'
#' @param con DuckDB connection to the corpus DB
#' @return Tibble (Handle, doi, doi_source)
#' @export
extract_dois_from_url <- function(con) {
  DBI::dbGetQuery(con, "
    SELECT Handle, url FROM articles
    WHERE url IS NOT NULL AND url LIKE '%10.%'
  ") |>
    tibble::as_tibble() |>
    dplyr::mutate(
      doi = stringr::str_extract(url, "10\\.\\d{4,9}/[^\\s?#&]+"),
      doi = normalize_doi(doi)
    ) |>
    dplyr::filter(!is.na(doi)) |>
    dplyr::distinct(Handle, .keep_all = TRUE) |>
    dplyr::transmute(Handle, doi, doi_source = "url")
}

#' Build the DOI backfill patch from local sources
#'
#' Combines RDS-cache and url-column extraction (redif wins on conflict) and
#' writes an update_columns patch for articles. Only handles currently in the
#' DB are included, and rows that already carry the same DOI are dropped so
#' re-runs produce minimal patches.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param rds_folder Path to RDS files. Defaults to config$rds_folder
#' @param pqt_patch_folder Patch output folder. Defaults to config$pqt_patch_folder
#' @return Manifest path (invisibly), or NULL when nothing to patch
#' @export
build_doi_patch <- function(db_path = NULL,
                            rds_folder = NULL,
                            pqt_patch_folder = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  current <- DBI::dbGetQuery(con, "SELECT Handle, doi FROM articles") |>
    tibble::as_tibble()

  candidates <- dplyr::bind_rows(
    extract_dois_from_rds(rds_folder),
    extract_dois_from_url(con)
  ) |>
    # bind_rows order + distinct keeps the first occurrence: redif beats url
    dplyr::distinct(Handle, .keep_all = TRUE) |>
    dplyr::semi_join(current, by = "Handle") |>
    dplyr::anti_join(
      dplyr::filter(current, !is.na(doi)),
      by = c("Handle", "doi")
    )

  info("DOI patch: ", nrow(candidates), " handles to update (",
       sum(candidates$doi_source == "redif"), " redif, ",
       sum(candidates$doi_source == "url"), " url)")

  if (nrow(candidates) == 0) return(invisible(NULL))

  write_patch(
    candidates,
    target_table = "articles",
    key_cols = "Handle",
    mode = "update_columns",
    pqt_patch_folder = pqt_patch_folder
  )
}

# --- Crossref backfill -------------------------------------------------------

crossref_score_threshold <- function() {
  as.numeric(Sys.getenv("EDDY_CROSSREF_SCORE_MIN", "85"))
}

first_author_token <- function(authors) {
  first <- stringr::str_split(authors %||% "", ";")[[1]][1]
  parts <- stringr::str_split(stringr::str_trim(first), "\\s+")[[1]]
  tolower(parts[length(parts)])
}

#' Query Crossref for one bibliographic match with guards
#'
#' Polite-pool request (mailto). Returns a one-row tibble with the matched DOI
#' and evidence, or NULL when no candidate survives the guards:
#' - score >= threshold (env EDDY_CROSSREF_SCORE_MIN, default 85)
#' - |year difference| <= 1
#' - Crossref type agrees with is_series (journal-article vs report/posted-content):
#'   a live probe showed WP DOIs outranking the published article's own DOI,
#'   so type agreement is mandatory, not advisory.
#' - first-author lastname appears among Crossref authors
#'
#' @param title Article title
#' @param authors Semicolon-separated author string (corpus format)
#' @param year Publication year
#' @param is_series TRUE for working-paper series rows
#' @param mailto Contact email for the Crossref polite pool
#' @return Tibble row (doi, cr_title, cr_year, cr_type, score) or NULL
#' @export
crossref_match_one <- function(title, authors, year, is_series, mailto) {
  url <- httr2::request("https://api.crossref.org/works") |>
    httr2::req_url_query(
      query.bibliographic = paste(title, first_author_token(authors)),
      rows = 3,
      select = "DOI,title,issued,type,author,score",
      mailto = mailto
    ) |>
    httr2::req_user_agent(paste0("eddyspapers-doi-backfill (mailto:", mailto, ")")) |>
    httr2::req_timeout(30) |>
    httr2::req_retry(max_tries = 3, backoff = ~10)

  resp <- tryCatch(httr2::req_perform(url), error = function(e) NULL)
  if (is.null(resp) || httr2::resp_status(resp) != 200) return(NULL)

  items <- httr2::resp_body_json(resp)$message$items
  if (length(items) == 0) return(NULL)

  article_types <- c("journal-article")
  series_types  <- c("report", "posted-content")
  author_needle <- first_author_token(authors)

  matches <- purrr::map(items, function(it) {
    score   <- it$score %||% 0
    cr_type <- it$type %||% ""
    cr_year <- tryCatch(it$issued$`date-parts`[[1]][[1]], error = function(e) NULL)
    cr_authors <- purrr::map_chr(it$author %||% list(), ~tolower(.x$family %||% "")) |>
      paste(collapse = " ")

    type_ok <- if (isTRUE(is_series)) cr_type %in% series_types else cr_type %in% article_types
    year_ok <- !is.null(cr_year) &&
      isTRUE(abs(suppressWarnings(as.integer(cr_year)) - as.integer(year)) <= 1)
    author_ok <- isTRUE(nchar(author_needle) > 0) &&
      isTRUE(stringr::str_detect(cr_authors, stringr::fixed(author_needle)))

    if (isTRUE(score >= crossref_score_threshold() && type_ok && year_ok && author_ok)) {
      tibble::tibble(
        doi      = normalize_doi(it$DOI),
        cr_title = (it$title %||% list(""))[[1]],
        cr_year  = as.integer(cr_year),
        cr_type  = cr_type,
        score    = score
      )
    } else {
      NULL
    }
  }) |>
    purrr::compact()

  if (length(matches) == 0) return(NULL)
  dplyr::filter(matches[[1]], !is.na(doi))
}

#' Resumable Crossref DOI backfill
#'
#' Works through DOI-less articles (published articles first — WP series have
#' near-zero mint rates), one polite request per handle, recording every
#' attempt (hit or miss) in a state parquet so re-runs never re-query. Emits an
#' update_columns patch (doi_source 'crossref') for the hits of this run.
#'
#' Run a calibration sample first (limit = 500), hand-check the emitted
#' attempts file, adjust EDDY_CROSSREF_SCORE_MIN if needed, then run with
#' limit = Inf overnight (~3 req/s polite ceiling is respected via delay).
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param mailto Contact email for the polite pool (required)
#' @param limit Max handles to attempt this run
#' @param include_series Also attempt working-paper rows (default FALSE)
#' @param state_path Attempts parquet. Defaults to {pqt_patch_folder}/crossref_attempts.parquet
#' @param delay_secs Sleep between requests (default 0.4 ≈ 2.5 req/s)
#' @return Tibble of this run's attempts (invisibly)
#' @export
crossref_backfill <- function(db_path = NULL,
                              mailto,
                              limit = 500,
                              include_series = FALSE,
                              state_path = NULL,
                              delay_secs = 0.4) {
  stopifnot(nchar(mailto) > 0)
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) {
    state_path <- file.path(config$pqt_patch_folder, "crossref_attempts.parquet")
  }

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  attempted <- if (file.exists(state_path)) {
    read_parquet_df(state_path)
  } else {
    tibble::tibble(
      Handle = character(), doi = character(), score = numeric(),
      cr_type = character(), attempted_at = as.POSIXct(character())
    )
  }

  series_clause <- if (include_series) "" else "AND NOT is_series"
  todo <- DBI::dbGetQuery(con, sprintf("
    SELECT Handle, title, authors, year, is_series
    FROM articles
    WHERE doi IS NULL AND title IS NOT NULL AND year IS NOT NULL %s
    ORDER BY is_series, year DESC
  ", series_clause)) |>
    tibble::as_tibble() |>
    dplyr::anti_join(attempted, by = "Handle")
  if (is.finite(limit)) todo <- dplyr::slice_head(todo, n = as.integer(limit))

  info("Crossref backfill: ", nrow(todo), " handles to attempt (",
       nrow(attempted), " already attempted)")
  if (nrow(todo) == 0) return(invisible(attempted[0, ]))

  # State checkpoints every 50 attempts so a crash or Ctrl-C mid-run (this can
  # be a multi-hour job) loses at most one checkpoint of polite-pool budget,
  # not the whole run — that's what makes the anti_join above truly resumable.
  checkpoint_every <- 50L
  results_acc <- list()
  checkpoint <- function() {
    write_parquet_df(
      dplyr::bind_rows(attempted, purrr::list_rbind(results_acc)),
      state_path
    )
  }

  purrr::walk(seq_len(nrow(todo)), function(i) {
    row <- todo[i, ]
    if (i %% checkpoint_every == 0) info("  ", i, "/", nrow(todo))
    Sys.sleep(delay_secs)
    hit <- tryCatch(
      crossref_match_one(row$title, row$authors, row$year, row$is_series, mailto),
      error = function(e) NULL
    )
    results_acc[[i]] <<- tibble::tibble(
      Handle       = row$Handle,
      doi          = if (is.null(hit) || nrow(hit) == 0) NA_character_ else hit$doi,
      score        = if (is.null(hit) || nrow(hit) == 0) NA_real_ else hit$score,
      cr_type      = if (is.null(hit) || nrow(hit) == 0) NA_character_ else hit$cr_type,
      attempted_at = Sys.time()
    )
    if (i %% checkpoint_every == 0) checkpoint()
  })

  results <- purrr::list_rbind(results_acc)
  checkpoint()

  hits <- dplyr::filter(results, !is.na(doi)) |>
    dplyr::transmute(Handle, doi, doi_source = "crossref")

  info("Crossref backfill run: ", nrow(hits), "/", nrow(results), " matched")

  if (nrow(hits) > 0) {
    write_patch(
      hits,
      target_table = "articles",
      key_cols = "Handle",
      mode = "update_columns"
    )
  }

  invisible(results)
}
