# Tiered DOI backfill --------------------------------------------------------
#
# DOI-lessness in the corpus is host-determined, not random (see
# localwip/notes/data_enrichment/04_tiered_doi.md). This module replaces the
# blind Crossref title-query route with two targeted, host-aware routes and
# skips the ~160k handles on hosts that never mint DOIs (MPRA/arXiv/NBER/...).
#
#   1. Nature  — nature.com/articles/<id> -> 10.1038/<id>, verified per DOI.
#   2. Container — publisher journals (Elsevier/Cambridge/Wiley/...): a
#      container-title-constrained Crossref query guarded by title similarity +
#      year + type. Crossref's own `score` is NOT used as a floor here: a live
#      probe matched 12/12 Elsevier papers correctly with scores as low as 47,
#      because constraining to one journal makes the top hit reliable.

# --- shared helpers ---------------------------------------------------------

normalize_title <- function(x) {
  (x %||% "") |>
    tolower() |>
    stringr::str_replace_all("[^a-z0-9]+", " ") |>
    stringr::str_squish()
}

#' Normalized-token Jaccard similarity between two titles
#'
#' Scalar in [0, 1]. Used as the primary match guard for the tiered routes —
#' more reliable than Crossref's opaque `score` once the candidate set is
#' constrained to one journal or one DOI.
#'
#' @param a,b Title strings
#' @return Numeric Jaccard similarity
#' @export
title_sim <- function(a, b) {
  ta <- unique(strsplit(normalize_title(a), " ", fixed = TRUE)[[1]])
  tb <- unique(strsplit(normalize_title(b), " ", fixed = TRUE)[[1]])
  ta <- ta[nzchar(ta)]; tb <- tb[nzchar(tb)]
  if (length(ta) == 0 || length(tb) == 0) return(0)
  length(intersect(ta, tb)) / length(union(ta, tb))
}

crossref_ua <- function(mailto) {
  paste0("eddyspapers-doi-backfill (mailto:", mailto, ")")
}

# Read a resumable attempt ledger, or an empty typed one.
read_doi_ledger <- function(state_path, extra_cols = list()) {
  if (file.exists(state_path)) return(read_parquet_df(state_path))
  base <- tibble::tibble(Handle = character(), doi = character())
  dplyr::bind_cols(base, tibble::as_tibble(extra_cols), tibble::tibble(attempted_at = as.POSIXct(character())))
}

# Parse a Crossref /works/{doi} response into title/type, tolerating the error
# objects that req_perform_parallel(on_error = "continue") returns for failures.
parse_crossref_work <- function(resp) {
  if (is.null(resp) || inherits(resp, c("condition", "error"))) return(NULL)
  if (httr2::resp_status(resp) != 200) return(NULL)
  it <- httr2::resp_body_json(resp)$message
  list(title = (it$title %||% list(""))[[1]], type = it$type %||% "")
}

# Shared chunked-parallel attempt engine. Fires each chunk's requests
# concurrently (max_active bounded, throttled per request), evaluates every
# response, appends to the ledger, and checkpoints once per chunk — same
# resumability guarantee as the sequential loop (a crash loses at most one
# chunk, resume anti-joins on Handle), at a fraction of the wall-clock because
# Crossref latency (~1s/search) is the bottleneck, not our request rate.
perform_doi_attempts <- function(todo, build_req, eval_row, attempted, state_path,
                                 max_active = 8L, chunk = 400L) {
  results_acc <- list()
  checkpoint <- function() {
    write_parquet_df(dplyr::bind_rows(attempted, purrr::list_rbind(results_acc)), state_path)
  }
  n <- nrow(todo)
  starts <- seq.int(1L, n, by = chunk)
  purrr::walk(starts, function(s) {
    idx  <- s:min(s + chunk - 1L, n)
    reqs <- purrr::map(idx, function(i) build_req(todo[i, ]))
    resps <- httr2::req_perform_parallel(reqs, on_error = "continue",
                                         max_active = max_active, progress = FALSE)
    rows <- purrr::map(seq_along(idx), function(k) eval_row(todo[idx[k], ], resps[[k]]))
    results_acc[[length(results_acc) + 1L]] <<- purrr::list_rbind(rows)
    info("  ", min(s + chunk - 1L, n), "/", n)
    checkpoint()
  })
  purrr::list_rbind(results_acc)
}

# --- Route 1: Nature id transform -------------------------------------------

#' Deterministic Nature DOI guess from an article URL
#'
#' `nature.com/articles/<id>` -> `10.1038/<id>` (lowercased). Returns NA for
#' non-Nature or id-less URLs. The guess is always verified against Crossref
#' before it is trusted — a wrong DOI is worse than a missing one.
#'
#' @param url Character vector of article URLs
#' @return Character vector of DOI guesses (NA where inapplicable)
#' @export
nature_doi_guess <- function(url) {
  id <- stringr::str_match(tolower(url %||% ""), "nature\\.com/articles/([^/?#]+)")[, 2]
  dplyr::if_else(!is.na(id) & nzchar(id), paste0("10.1038/", id), NA_character_)
}

#' Nature DOI from a URL, restricted to structurally-safe id shapes
#'
#' `nature.com/articles/<id>` -> `10.1038/<id>`, but only for id shapes where
#' that identity is guaranteed: modern (`s...`), legacy numeric, Nature news
#' (`d41586...`), and Nature-Portfolio journal prefixes. Ambiguous legacy codes
#' (e.g. migrated non-Nature journals) return NA — a wrong DOI is worse than a
#' missing one, so those are left for explicit verification instead.
#'
#' @param url Character vector of article URLs
#' @return Character vector of safe DOIs (NA where not provably safe)
#' @export
nature_safe_doi <- function(url) {
  id <- stringr::str_match(tolower(url %||% ""), "nature\\.com/articles/([^/?#]+)")[, 2]
  portfolio <- "^(nature|ncomms|srep|nmeth|nbt|ng|nphys|nchem|nmat|nnano|nclimate|nplants|nmicrobiol|nenergy|nrdp|nrg|nrn|nri|nrc|nrm|nrd|bjc|onc|leu|ki|pr|jid|mp|tp|cddis|cr|aps|ijos|bonekey)"
  safe <- !is.na(id) & nzchar(id) & (
    stringr::str_detect(id, "^s[0-9]") |
    stringr::str_detect(id, "^[0-9]") |
    stringr::str_detect(id, "^d41586") |
    stringr::str_detect(id, portfolio)
  )
  dplyr::if_else(safe, paste0("10.1038/", id), NA_character_)
}

#' Apply the deterministic Nature transform (no API) into the ledger
#'
#' Writes `10.1038/<id>` for every DOI-less `nature.com/articles/<id>` handle of
#' a structurally-safe shape (see `nature_safe_doi`) straight into the nature
#' ledger, merging with any already-verified hits (deduped by Handle). Free and
#' instant — used when API verification budget is unavailable but the transform
#' is trusted for these shapes. `sim` is NA to mark rows as transform-derived
#' rather than title-verified.
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/nature_attempts.parquet
#' @return Tibble of the ledger after applying (invisibly)
#' @export
nature_transform_backfill <- function(db_path = NULL, state_path = NULL) {
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) state_path <- file.path(config$pqt_patch_folder, "nature_attempts.parquet")

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  existing <- read_doi_ledger(state_path, list(sim = numeric()))

  hits <- DBI::dbGetQuery(con, "
    SELECT Handle, url FROM articles
    WHERE doi IS NULL AND lower(url) LIKE '%nature.com/articles/%'") |>
    tibble::as_tibble() |>
    dplyr::mutate(doi = normalize_doi(nature_safe_doi(url))) |>
    dplyr::filter(!is.na(doi)) |>
    dplyr::transmute(Handle, doi, sim = NA_real_, attempted_at = Sys.time()) |>
    dplyr::anti_join(existing, by = "Handle")

  merged <- dplyr::bind_rows(existing, hits)
  write_parquet_df(merged, state_path)
  info("Nature transform: applied ", nrow(hits), " new safe-shape DOIs (",
       nrow(merged), " total in ledger)")
  invisible(merged)
}

#' Fetch a Crossref work by DOI (existence + title/type)
#'
#' @param doi DOI to look up
#' @param mailto Polite-pool contact
#' @return list(title, type) or NULL when the DOI does not resolve
#' @export
# 429 (rate-limit), 500/502/503 (transient) are retryable; a guessed Nature DOI
# that doesn't exist returns 404, which is a legitimate "no match" — NOT retried
# and swallowed by is_error=FALSE so it parses to NULL rather than throwing.
crossref_transient <- function(resp) httr2::resp_status(resp) %in% c(429, 500, 502, 503)
crossref_backoff <- function(i) min(2^i, 30)

nature_request <- function(doi, mailto) {
  httr2::request("https://api.crossref.org/works") |>
    httr2::req_url_path_append(doi) |>
    httr2::req_url_query(mailto = mailto) |>
    httr2::req_user_agent(crossref_ua(mailto)) |>
    httr2::req_timeout(40) |>
    httr2::req_error(is_error = function(resp) FALSE) |>
    httr2::req_retry(max_tries = 6, is_transient = crossref_transient, backoff = crossref_backoff)
}

crossref_get_work <- function(doi, mailto) {
  resp <- tryCatch(httr2::req_perform(nature_request(doi, mailto)), error = function(e) NULL)
  parse_crossref_work(resp)
}

# Evaluate one Nature response into a ledger row (Handle + verified doi/sim).
nature_eval_row <- function(row, resp, min_sim) {
  meta <- parse_crossref_work(resp)
  sim  <- if (is.null(meta)) NA_real_ else title_sim(row$title, meta$title)
  ok   <- !is.null(meta) && isTRUE(sim >= min_sim)
  tibble::tibble(
    Handle       = row$Handle,
    doi          = if (ok) normalize_doi(row$doi_guess) else NA_character_,
    sim          = sim,
    attempted_at = Sys.time()
  )
}

#' Resumable Nature DOI backfill
#'
#' Works through DOI-less `nature.com/articles/<id>` handles, verifying each
#' `10.1038/<id>` guess against Crossref (existence + title similarity). Records
#' every attempt in a state parquet so re-runs never re-query. Writes no patch
#' itself — hits are collected by `finalize_doi_patch()`.
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param mailto Polite-pool contact (required)
#' @param limit Max handles to attempt this run
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/nature_attempts.parquet
#' @param delay_secs Sleep between requests
#' @param min_sim Minimum title similarity to accept a verified DOI
#' @return Tibble of this run's attempts (invisibly)
#' @export
nature_backfill <- function(db_path = NULL, mailto, limit = Inf, state_path = NULL,
                            min_sim = 0.4, max_active = 8L, chunk = 400L) {
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
    dplyr::anti_join(attempted, by = "Handle")
  if (is.finite(limit)) todo <- dplyr::slice_head(todo, n = as.integer(limit))

  info("Nature backfill: ", nrow(todo), " handles to attempt (", nrow(attempted), " already attempted)")
  if (nrow(todo) == 0) return(invisible(attempted[0, ]))

  results <- perform_doi_attempts(
    todo,
    build_req = function(row) nature_request(row$doi_guess, mailto),
    eval_row  = function(row, resp) nature_eval_row(row, resp, min_sim),
    attempted = attempted, state_path = state_path,
    max_active = max_active, chunk = chunk
  )
  info("Nature backfill run: ", sum(!is.na(results$doi)), "/", nrow(results), " verified")
  invisible(results)
}

# --- Route 2: container-title Crossref --------------------------------------

# Publisher hosts whose journal name we trust as a Crossref container filter.
container_host_patterns <- function() c(
  "sciencedirect.com", "cambridge.org", "onlinelibrary.wiley.com", "wiley.com",
  "tandfonline.com", "academic.oup.com", "journals.sagepub.com", "sagepub.com",
  "link.springer.com", "springerlink", "jstor.org", "kluweronline.com"
)

# Pure guard + selection over scored Crossref candidates. Factored out of the
# network path so the match logic can be unit-tested offline. Keeps only rows
# with a valid DOI, type journal-article, a non-NA year within 1 of `year`, and
# sim >= min_sim, then returns the single highest-sim row (or NULL).
container_pick_best <- function(scored, year, min_sim = 0.5) {
  if (nrow(scored) == 0) return(NULL)
  best <- scored |>
    dplyr::filter(!is.na(doi), cr_type == "journal-article",
                  !is.na(cr_year), abs(cr_year - as.integer(year)) <= 1,
                  sim >= min_sim) |>
    dplyr::slice_max(sim, n = 1, with_ties = FALSE)
  if (nrow(best) == 0) NULL else best
}

#' Query Crossref for one match constrained to a journal (container-title)
#'
#' Constrains the search to `container` and returns the top hit whose title
#' clears `min_sim`, year is within 1, and type is journal-article. No score
#' floor — see module header for why score is unreliable under this constraint.
#'
#' @param title Article title
#' @param authors Semicolon-separated author string
#' @param year Publication year
#' @param container Journal name (Crossref container-title filter)
#' @param mailto Polite-pool contact
#' @param min_sim Minimum title similarity to accept
#' @return Tibble row (doi, sim, cr_year, cr_type, score) or NULL
#' @export
container_request <- function(title, authors, year, container, mailto) {
  httr2::request("https://api.crossref.org/works") |>
    httr2::req_url_query(
      query.bibliographic = paste(title, first_author_token(authors)),
      `query.container-title` = container,
      rows = 3,
      select = "DOI,title,issued,type,score",
      mailto = mailto
    ) |>
    httr2::req_user_agent(crossref_ua(mailto)) |>
    httr2::req_timeout(40) |>
    httr2::req_error(is_error = function(resp) FALSE) |>
    httr2::req_retry(max_tries = 8, is_transient = crossref_transient, backoff = crossref_backoff)
}

# Score a Crossref search response's items against the query title.
score_crossref_items <- function(items, title) {
  purrr::map(items, function(it) {
    cr_year <- tryCatch(it$issued$`date-parts`[[1]][[1]], error = function(e) NULL)
    tibble::tibble(
      doi     = normalize_doi(it$DOI %||% NA_character_),
      sim     = title_sim(title, (it$title %||% list(""))[[1]]),
      cr_year = suppressWarnings(as.integer(cr_year %||% NA)),
      cr_type = it$type %||% "",
      score   = it$score %||% 0
    )
  }) |> purrr::list_rbind()
}

# Best guarded match from a container search response (NULL on failure/no hit).
container_match_from_resp <- function(resp, title, year, min_sim) {
  if (is.null(resp) || inherits(resp, c("condition", "error"))) return(NULL)
  if (httr2::resp_status(resp) != 200) return(NULL)
  items <- httr2::resp_body_json(resp)$message$items
  if (length(items) == 0) return(NULL)
  container_pick_best(score_crossref_items(items, title), year, min_sim)
}

crossref_container_match_one <- function(title, authors, year, container, mailto, min_sim = 0.5) {
  resp <- tryCatch(httr2::req_perform(container_request(title, authors, year, container, mailto)),
                   error = function(e) NULL)
  container_match_from_resp(resp, title, year, min_sim)
}

# Evaluate one container response into a ledger row.
container_eval_row <- function(row, resp, min_sim) {
  hit <- container_match_from_resp(resp, row$title, row$year, min_sim)
  tibble::tibble(
    Handle       = row$Handle,
    doi          = if (is.null(hit)) NA_character_ else hit$doi,
    sim          = if (is.null(hit)) NA_real_ else hit$sim,
    cr_type      = if (is.null(hit)) NA_character_ else hit$cr_type,
    score        = if (is.null(hit)) NA_real_ else hit$score,
    attempted_at = Sys.time()
  )
}

#' Resumable container-title Crossref backfill
#'
#' Attempts DOI-less handles on trusted publisher hosts with a
#' journal-constrained Crossref query. Resumable via a state parquet; writes no
#' patch itself (see `finalize_doi_patch()`). Re-attempts handles the blind
#' route missed (that's the upgrade) but never handles that already carry a DOI.
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param mailto Polite-pool contact (required)
#' @param limit Max handles to attempt this run
#' @param hosts URL host substrings to include. Defaults to publisher journals
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/crossref_container_attempts.parquet
#' @param delay_secs Sleep between requests
#' @param min_sim Minimum title similarity to accept
#' @return Tibble of this run's attempts (invisibly)
#' @export
crossref_container_backfill <- function(db_path = NULL, mailto, limit = Inf, hosts = NULL,
                                        state_path = NULL, min_sim = 0.5,
                                        max_active = 4L, chunk = 400L) {
  stopifnot(nchar(mailto) > 0)
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) state_path <- file.path(config$pqt_patch_folder, "crossref_container_attempts.parquet")
  if (is.null(hosts)) hosts <- container_host_patterns()

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  attempted <- read_doi_ledger(state_path, list(sim = numeric(), cr_type = character(), score = numeric()))

  host_clause <- paste(sprintf("lower(url) LIKE '%%%s%%'", hosts), collapse = " OR ")
  todo <- DBI::dbGetQuery(con, sprintf("
    SELECT Handle, title, authors, year, journal FROM articles
    WHERE doi IS NULL AND title IS NOT NULL AND year IS NOT NULL AND journal IS NOT NULL
      AND (%s)
    ORDER BY year DESC", host_clause)) |>
    tibble::as_tibble() |>
    dplyr::anti_join(attempted, by = "Handle")
  if (is.finite(limit)) todo <- dplyr::slice_head(todo, n = as.integer(limit))

  info("Container backfill: ", nrow(todo), " handles to attempt (", nrow(attempted), " already attempted)")
  if (nrow(todo) == 0) return(invisible(attempted[0, ]))

  results <- perform_doi_attempts(
    todo,
    build_req = function(row) container_request(row$title, row$authors, row$year, row$journal, mailto),
    eval_row  = function(row, resp) container_eval_row(row, resp, min_sim),
    attempted = attempted, state_path = state_path,
    max_active = max_active, chunk = chunk
  )
  info("Container backfill run: ", sum(!is.na(results$doi)), "/", nrow(results), " matched")
  invisible(results)
}

# --- Finalize: one patch from every source ----------------------------------

# Hits from an attempt ledger, normalized + tagged with provenance.
ledger_doi_hits <- function(state_path, doi_source) {
  if (!file.exists(state_path)) return(tibble::tibble(Handle = character(), doi = character(), doi_source = character()))
  read_parquet_df(state_path) |>
    dplyr::mutate(doi = normalize_doi(doi)) |>
    dplyr::filter(!is.na(doi)) |>
    dplyr::distinct(Handle, .keep_all = TRUE) |>
    dplyr::transmute(Handle, doi, doi_source = doi_source)
}

#' Build one DOI update_columns patch from every source
#'
#' Folds local extraction (RDS `redif`, `url`) and every attempt ledger
#' (`nature_transform`, `openalex`, `crossref_container`, blind `crossref`) into
#' a single patch, deduped by Handle with provenance priority
#' redif > url > nature_transform > openalex > crossref_container > crossref.
#' Authoritative sources (redif/url) may correct a stale DOI; the fuzzy ledgers
#' only fill doi-less handles. Rows already
#' carrying the same DOI are dropped so re-runs stay minimal. This is what
#' rescues the interrupted blind run's 571 hits (never written to a patch).
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param rds_folder RDS cache. Defaults to config$rds_folder
#' @param pqt_patch_folder Patch output. Defaults to config$pqt_patch_folder
#' @return Manifest path (invisibly), or NULL when nothing to patch
#' @export
finalize_doi_patch <- function(db_path = NULL, rds_folder = NULL, pqt_patch_folder = NULL) {
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(pqt_patch_folder)) pqt_patch_folder <- config$pqt_patch_folder
  pf <- pqt_patch_folder

  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)

  current <- DBI::dbGetQuery(con, "SELECT Handle, doi FROM articles") |> tibble::as_tibble()
  doi_less <- dplyr::filter(current, is.na(doi))

  # Authoritative sources (DOI read straight from ReDIF or embedded in the url)
  # may correct a stale existing DOI. The fuzzy match/transform ledgers may only
  # FILL currently-doi-less handles — they never overwrite an existing DOI that
  # no live route re-verified this run (the backfills themselves only ever
  # target `doi IS NULL`, so this keeps finalize consistent with that intent).
  authoritative <- dplyr::bind_rows(
    extract_dois_from_rds(rds_folder),   # redif
    extract_dois_from_url(con)           # url
  )
  fuzzy <- dplyr::bind_rows(
    ledger_doi_hits(file.path(pf, "nature_attempts.parquet"), "nature_transform"),
    ledger_doi_hits(file.path(pf, "openalex_attempts.parquet"), "openalex"),
    ledger_doi_hits(file.path(pf, "crossref_container_attempts.parquet"), "crossref_container"),
    ledger_doi_hits(file.path(pf, "crossref_attempts.parquet"), "crossref")
  ) |>
    dplyr::semi_join(doi_less, by = "Handle")

  candidates <- dplyr::bind_rows(authoritative, fuzzy) |>
    # bind order encodes provenance priority; distinct keeps first occurrence:
    # redif > url > nature_transform > crossref_container > crossref
    dplyr::distinct(Handle, .keep_all = TRUE) |>
    dplyr::semi_join(current, by = "Handle") |>
    dplyr::anti_join(dplyr::filter(current, !is.na(doi)), by = c("Handle", "doi"))

  by_src <- candidates |> dplyr::count(doi_source)
  info("DOI finalize: ", nrow(candidates), " handles to update (",
       paste(sprintf("%s=%d", by_src$doi_source, by_src$n), collapse = ", "), ")")

  if (nrow(candidates) == 0) return(invisible(NULL))

  write_patch(
    candidates,
    target_table = "articles",
    key_cols = "Handle",
    mode = "update_columns",
    pqt_patch_folder = pqt_patch_folder
  )
}
