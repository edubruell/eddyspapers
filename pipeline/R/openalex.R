# OpenAlex DOI backfill ------------------------------------------------------
#
# Crossref's bibliographic search endpoint is rate-limited to ~1 req/s and
# punishes concurrency (see 04_tiered_doi.md), so the publisher-journal DOI
# backfill runs against OpenAlex instead — generous polite pool, parallel-safe,
# and the same source Wave 2 builds on. Two routes, mirroring the tiered design:
#
#   1. Nature  — batch-verify each 10.1038/<id> transform against OpenAlex by
#      DOI, up to 50 DOIs per request (54k papers -> ~1.1k calls).
#   2. Container — publisher journals: OpenAlex title `search` + publication_year
#      filter, guarded by title similarity + type. Same guard philosophy as the
#      Crossref route; OpenAlex's ranking is reliable so we keep the top hit that
#      clears the similarity floor.

oa_ua <- function(mailto) paste0("eddyspapers-doi-backfill (mailto:", mailto, ")")

# Optional free API key (raises reliability of the polite pool); mailto works
# without one for moderate volume.
oa_api_key <- function() {
  k <- Sys.getenv("EDDY_OPENALEX_KEY", "")
  if (nzchar(k)) k else NULL
}

oa_transient <- function(resp) httr2::resp_status(resp) %in% c(429, 500, 502, 503)

oa_request <- function(query, mailto) {
  params <- c(query, list(mailto = mailto))
  key <- oa_api_key(); if (!is.null(key)) params <- c(params, list(api_key = key))
  do.call(httr2::req_url_query, c(list(httr2::request("https://api.openalex.org/works")), params)) |>
    httr2::req_user_agent(oa_ua(mailto)) |>
    httr2::req_timeout(40) |>
    # OpenAlex polite pool allows ~10 req/s; throttle (realm-shared across the
    # parallel pool) keeps aggregate rate under it so we don't self-inflict 429s.
    httr2::req_throttle(capacity = 9, fill_time_s = 1) |>
    httr2::req_error(is_error = function(resp) FALSE) |>
    httr2::req_retry(max_tries = 5, is_transient = oa_transient, backoff = crossref_backoff)
}

# --- Route 1: Nature transform, batch-verified via OpenAlex ------------------

#' Look up up to ~50 DOIs in one OpenAlex request
#'
#' @param dois Character vector of DOIs (bare, lowercase)
#' @param mailto Polite-pool contact
#' @return Tibble (doi, oa_title, oa_type) for the DOIs OpenAlex knows
#' @export
openalex_lookup_dois <- function(dois, mailto) {
  empty <- tibble::tibble(doi = character(), oa_title = character(), oa_type = character())
  if (length(dois) == 0) return(empty)
  filt <- paste0("doi:", paste(dois, collapse = "|"))
  resp <- tryCatch(
    httr2::req_perform(oa_request(list(filter = filt, `per-page` = length(dois),
                                       select = "doi,title,type"), mailto)),
    error = function(e) NULL)
  if (is.null(resp) || inherits(resp, "condition") || httr2::resp_status(resp) != 200) return(empty)
  res <- httr2::resp_body_json(resp)$results
  if (length(res) == 0) return(empty)
  purrr::map(res, function(x) tibble::tibble(
    doi      = normalize_doi(x$doi %||% NA_character_),
    oa_title = x$title %||% "",
    oa_type  = x$type %||% ""
  )) |> purrr::list_rbind() |> dplyr::filter(!is.na(doi))
}

#' Resumable Nature DOI backfill, verified in batches via OpenAlex
#'
#' Transforms each `nature.com/articles/<id>` to `10.1038/<id>`, then verifies
#' in batches of up to `batch` DOIs against OpenAlex (existence + title
#' similarity). Ledger schema matches `nature_backfill` (Handle, doi, sim,
#' attempted_at) so its hits and this run's are interchangeable at finalize.
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param mailto Polite-pool contact (required)
#' @param limit Max handles to attempt this run
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/nature_attempts.parquet
#' @param min_sim Minimum title similarity to accept a verified DOI
#' @param batch DOIs per OpenAlex request (max 50)
#' @return Tibble of this run's attempts (invisibly)
#' @export
nature_backfill_openalex <- function(db_path = NULL, mailto, limit = Inf, state_path = NULL,
                                     min_sim = 0.4, batch = 50L) {
  stopifnot(nchar(mailto) > 0)
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) state_path <- file.path(config$pqt_patch_folder, "nature_attempts.parquet")

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  attempted <- read_doi_ledger(state_path, list(sim = numeric()))

  todo <- DBI::dbGetQuery(con, "
    SELECT Handle, title, url FROM articles
    WHERE doi IS NULL AND lower(url) LIKE '%nature.com/articles/%'") |>
    tibble::as_tibble() |>
    dplyr::mutate(doi_guess = nature_doi_guess(url)) |>
    dplyr::filter(!is.na(doi_guess)) |>
    dplyr::distinct(doi_guess, .keep_all = TRUE) |>   # a DOI verifies once, dedupe up front
    dplyr::anti_join(attempted, by = "Handle")
  if (is.finite(limit)) todo <- dplyr::slice_head(todo, n = as.integer(limit))

  info("Nature/OpenAlex backfill: ", nrow(todo), " handles to attempt (", nrow(attempted), " already attempted)")
  if (nrow(todo) == 0) return(invisible(attempted[0, ]))

  results_acc <- list()
  checkpoint <- function() {
    write_parquet_df(dplyr::bind_rows(attempted, purrr::list_rbind(results_acc)), state_path)
  }
  n <- nrow(todo)
  starts <- seq.int(1L, n, by = batch)
  purrr::walk(starts, function(s) {
    idx   <- s:min(s + batch - 1L, n)
    block <- todo[idx, ]
    looked <- openalex_lookup_dois(block$doi_guess, mailto)
    title_by_doi <- stats::setNames(looked$oa_title, looked$doi)
    rows <- purrr::map(seq_len(nrow(block)), function(k) {
      g <- block$doi_guess[k]
      oa_title <- if (g %in% names(title_by_doi)) title_by_doi[[g]] else NULL
      sim <- if (is.null(oa_title)) NA_real_ else title_sim(block$title[k], oa_title)
      ok  <- !is.null(oa_title) && isTRUE(sim >= min_sim)
      tibble::tibble(Handle = block$Handle[k],
                     doi = if (ok) normalize_doi(g) else NA_character_,
                     sim = sim, attempted_at = Sys.time())
    })
    results_acc[[length(results_acc) + 1L]] <<- purrr::list_rbind(rows)
    info("  ", min(s + batch - 1L, n), "/", n)
    checkpoint()
  })

  results <- purrr::list_rbind(results_acc)
  checkpoint()
  info("Nature/OpenAlex run: ", sum(!is.na(results$doi)), "/", nrow(results), " verified")
  invisible(results)
}

# --- Route 2: container journals via OpenAlex title search ------------------

openalex_container_request <- function(title, year, mailto) {
  oa_request(list(
    search = normalize_title(title),
    filter = paste0("publication_year:", year),
    `per-page` = 3,
    select = "doi,title,type,publication_year"
  ), mailto)
}

# Score an OpenAlex search response's results against the query title.
score_openalex_results <- function(results, title) {
  purrr::map(results, function(x) tibble::tibble(
    doi     = normalize_doi(x$doi %||% NA_character_),
    sim     = title_sim(title, x$title %||% ""),
    oa_type = x$type %||% ""
  )) |> purrr::list_rbind()
}

# Pure guard: keep the highest-sim result that has a DOI, is a published
# article/review (never a preprint — that would return the wrong version's DOI),
# and clears the similarity floor.
openalex_pick_best <- function(scored, min_sim = 0.5) {
  if (nrow(scored) == 0) return(NULL)
  best <- scored |>
    dplyr::filter(!is.na(doi), oa_type %in% c("article", "review"), sim >= min_sim) |>
    dplyr::slice_max(sim, n = 1, with_ties = FALSE)
  if (nrow(best) == 0) NULL else best
}

openalex_match_from_resp <- function(resp, title, min_sim) {
  if (is.null(resp) || inherits(resp, c("condition", "error"))) return(NULL)
  if (httr2::resp_status(resp) != 200) return(NULL)
  res <- httr2::resp_body_json(resp)$results
  if (length(res) == 0) return(NULL)
  openalex_pick_best(score_openalex_results(res, title), min_sim)
}

openalex_container_eval <- function(row, resp, min_sim) {
  hit <- openalex_match_from_resp(resp, row$title, min_sim)
  tibble::tibble(
    Handle       = row$Handle,
    doi          = if (is.null(hit)) NA_character_ else hit$doi,
    sim          = if (is.null(hit)) NA_real_ else hit$sim,
    oa_type      = if (is.null(hit)) NA_character_ else hit$oa_type,
    attempted_at = Sys.time()
  )
}

#' Resumable container DOI backfill via OpenAlex title search
#'
#' Attempts DOI-less handles on trusted publisher hosts with an OpenAlex
#' title+year search, guarded by title similarity + type. Uses the shared
#' parallel engine (OpenAlex is parallel-safe, unlike Crossref search).
#' Resumable; writes no patch itself (see `finalize_doi_patch()`).
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param mailto Polite-pool contact (required)
#' @param limit Max handles to attempt this run
#' @param hosts URL host substrings to include. Defaults to publisher journals
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/openalex_attempts.parquet
#' @param min_sim Minimum title similarity to accept
#' @param max_active Concurrent requests
#' @param chunk Rows per checkpoint
#' @return Tibble of this run's attempts (invisibly)
#' @export
container_backfill_openalex <- function(db_path = NULL, mailto, limit = Inf, hosts = NULL,
                                        state_path = NULL, min_sim = 0.5,
                                        max_active = 4L, chunk = 400L) {
  stopifnot(nchar(mailto) > 0)
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) state_path <- file.path(config$pqt_patch_folder, "openalex_attempts.parquet")
  if (is.null(hosts)) hosts <- container_host_patterns()

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  attempted <- read_doi_ledger(state_path, list(sim = numeric(), oa_type = character()))

  host_clause <- paste(sprintf("lower(url) LIKE '%%%s%%'", hosts), collapse = " OR ")
  todo <- DBI::dbGetQuery(con, sprintf("
    SELECT Handle, title, year, journal FROM articles
    WHERE doi IS NULL AND title IS NOT NULL AND year IS NOT NULL AND journal IS NOT NULL
      AND (%s)
    ORDER BY year DESC", host_clause)) |>
    tibble::as_tibble() |>
    dplyr::anti_join(attempted, by = "Handle")
  if (is.finite(limit)) todo <- dplyr::slice_head(todo, n = as.integer(limit))

  info("Container/OpenAlex backfill: ", nrow(todo), " handles to attempt (", nrow(attempted), " already attempted)")
  if (nrow(todo) == 0) return(invisible(attempted[0, ]))

  results <- perform_doi_attempts(
    todo,
    build_req = function(row) openalex_container_request(row$title, row$year, mailto),
    eval_row  = function(row, resp) openalex_container_eval(row, resp, min_sim),
    attempted = attempted, state_path = state_path,
    max_active = max_active, chunk = chunk
  )
  info("Container/OpenAlex run: ", sum(!is.na(results$doi)), "/", nrow(results), " matched")
  invisible(results)
}
