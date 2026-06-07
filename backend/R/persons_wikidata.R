WIKIDATA_SPARQL_ENDPOINT <- "https://query.wikidata.org/sparql"
WIKIDATA_BATCH_SIZE      <- 50L
WIKIDATA_SEP             <- "|||"

#' Initialize person_wikidata table
#'
#' @param con DuckDB connection
#' @return TRUE invisibly
#' @export
init_person_wikidata_table <- function(con) {
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS person_wikidata (
      short_id          VARCHAR PRIMARY KEY,
      wikidata_id       VARCHAR,
      wikipedia_url     VARCHAR,
      image_url         VARCHAR,
      birth_year        INTEGER,
      birth_place       VARCHAR,
      citizenships      VARCHAR[],
      educated_at       VARCHAR[],
      doctoral_advisors VARCHAR[],
      doctoral_students VARCHAR[],
      fields_of_work    VARCHAR[],
      memberships       VARCHAR[],
      awards            VARCHAR[],
      orcid             VARCHAR,
      google_scholar_id VARCHAR,
      ssrn_author_id    VARCHAR,
      math_genealogy_id VARCHAR,
      website           VARCHAR,
      fetched_date      DATE
    )
  ")
  invisible(TRUE)
}


build_wikidata_sparql <- function(short_ids) {
  values_str <- paste(sprintf('"%s"', short_ids), collapse = " ")
  sprintf(
    'SELECT ?repec_id ?wikidata_id
  (SAMPLE(STR(?image))         AS ?image_url)
  (SAMPLE(?birth_year_val)     AS ?birth_year)
  (SAMPLE(?birth_place_lbl)    AS ?birth_place)
  (GROUP_CONCAT(DISTINCT ?citizenship_lbl;    separator="|||") AS ?citizenships)
  (GROUP_CONCAT(DISTINCT ?educated_lbl;       separator="|||") AS ?educated_at)
  (GROUP_CONCAT(DISTINCT ?advisor_lbl;        separator="|||") AS ?doctoral_advisors)
  (GROUP_CONCAT(DISTINCT ?student_lbl;        separator="|||") AS ?doctoral_students)
  (GROUP_CONCAT(DISTINCT ?field_lbl;          separator="|||") AS ?fields_of_work)
  (GROUP_CONCAT(DISTINCT ?member_of_lbl;      separator="|||") AS ?memberships)
  (GROUP_CONCAT(DISTINCT ?award_lbl;          separator="|||") AS ?awards)
  (SAMPLE(?orcid_val)          AS ?orcid)
  (SAMPLE(?gscholar_val)       AS ?google_scholar_id)
  (SAMPLE(?ssrn_val)           AS ?ssrn_author_id)
  (SAMPLE(?math_gen_val)       AS ?math_genealogy_id)
  (SAMPLE(?website_val)        AS ?website)
  (SAMPLE(?wp_url)             AS ?wikipedia_url)
WHERE {
  VALUES ?repec_id { %s }
  ?item wdt:P2428 ?repec_id .
  BIND(STRAFTER(STR(?item), "entity/") AS ?wikidata_id)
  OPTIONAL { ?item wdt:P18  ?image }
  OPTIONAL { ?item wdt:P569 ?bd . BIND(YEAR(?bd) AS ?birth_year_val) }
  OPTIONAL { ?item wdt:P19  ?bp  . ?bp  rdfs:label ?birth_place_lbl . FILTER(LANG(?birth_place_lbl)  = "en") }
  OPTIONAL { ?item wdt:P27  ?c   . ?c   rdfs:label ?citizenship_lbl . FILTER(LANG(?citizenship_lbl)  = "en") }
  OPTIONAL { ?item wdt:P69  ?edu . ?edu rdfs:label ?educated_lbl    . FILTER(LANG(?educated_lbl)     = "en") }
  OPTIONAL { ?item wdt:P184 ?adv . ?adv rdfs:label ?advisor_lbl     . FILTER(LANG(?advisor_lbl)      = "en") }
  OPTIONAL { ?item wdt:P185 ?stu . ?stu rdfs:label ?student_lbl     . FILTER(LANG(?student_lbl)      = "en") }
  OPTIONAL { ?item wdt:P101 ?fld . ?fld rdfs:label ?field_lbl       . FILTER(LANG(?field_lbl)        = "en") }
  OPTIONAL { ?item wdt:P463 ?mem . ?mem rdfs:label ?member_of_lbl   . FILTER(LANG(?member_of_lbl)    = "en") }
  OPTIONAL { ?item wdt:P166 ?aw  . ?aw  rdfs:label ?award_lbl       . FILTER(LANG(?award_lbl)        = "en") }
  OPTIONAL { ?item wdt:P496  ?orcid_val }
  OPTIONAL { ?item wdt:P1960 ?gscholar_val }
  OPTIONAL { ?item wdt:P2703 ?ssrn_val }
  OPTIONAL { ?item wdt:P549  ?math_gen_val }
  OPTIONAL { ?item wdt:P856  ?website_val }
  OPTIONAL {
    ?wp_url schema:about ?item ;
            schema:inLanguage "en" ;
            schema:isPartOf <https://en.wikipedia.org/> .
  }
}
GROUP BY ?repec_id ?wikidata_id',
    values_str
  )
}


fetch_wikidata_batch <- function(short_ids) {
  query <- build_wikidata_sparql(short_ids)

  resp <- httr2::request(WIKIDATA_SPARQL_ENDPOINT) |>
    httr2::req_url_query(query = query, format = "json") |>
    httr2::req_headers(
      `User-Agent` = "EconPeople/1.0 (econpeople.eduard-bruell.de; contact: eduard.bruell@zew.de)"
    ) |>
    httr2::req_timeout(120) |>
    httr2::req_retry(max_tries = 3, backoff = \(i) 30) |>
    httr2::req_perform()

  rows <- httr2::resp_body_json(resp)$results$bindings
  if (length(rows) == 0) return(tibble::tibble())

  get_val <- function(r, key) {
    v <- r[[key]]
    if (is.null(v)) NA_character_ else v$value
  }

  split_field <- function(s) {
    if (is.null(s) || is.na(s) || nchar(s) == 0) return(character(0))
    trimws(strsplit(s, WIKIDATA_SEP, fixed = TRUE)[[1]])
  }

  purrr::map(rows, function(r) {
    tibble::tibble(
      short_id          = get_val(r, "repec_id"),
      wikidata_id       = get_val(r, "wikidata_id"),
      wikipedia_url     = get_val(r, "wikipedia_url"),
      image_url         = get_val(r, "image_url"),
      birth_year        = suppressWarnings(as.integer(get_val(r, "birth_year"))),
      birth_place       = get_val(r, "birth_place"),
      orcid             = get_val(r, "orcid"),
      google_scholar_id = get_val(r, "google_scholar_id"),
      ssrn_author_id    = get_val(r, "ssrn_author_id"),
      math_genealogy_id = get_val(r, "math_genealogy_id"),
      website           = get_val(r, "website"),
      citizenships      = list(split_field(get_val(r, "citizenships"))),
      educated_at       = list(split_field(get_val(r, "educated_at"))),
      doctoral_advisors = list(split_field(get_val(r, "doctoral_advisors"))),
      doctoral_students = list(split_field(get_val(r, "doctoral_students"))),
      fields_of_work    = list(split_field(get_val(r, "fields_of_work"))),
      memberships       = list(split_field(get_val(r, "memberships"))),
      awards            = list(split_field(get_val(r, "awards"))),
      fetched_date      = Sys.Date()
    )
  }) |>
    dplyr::bind_rows()
}


#' Sync Wikidata enrichment for persons
#'
#' Fetches only new persons (not yet in person_wikidata) and stale entries
#' (fetched_date older than refresh_days). Pass force = TRUE to drop and
#' rebuild the entire table from scratch.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param refresh_days Re-fetch rows older than this many days (default 30)
#' @param force Drop and rebuild the entire table (default FALSE)
#' @return Number of rows upserted (invisibly)
#' @export
sync_wikidata_persons <- function(db_path = NULL, refresh_days = 30L, force = FALSE) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }

  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con), add = TRUE)

  init_person_wikidata_table(con)

  if (force) {
    DBI::dbExecute(con, "DELETE FROM person_wikidata")
    to_fetch <- DBI::dbGetQuery(con, "SELECT short_id FROM persons")$short_id
    info("Force rebuild: querying Wikidata for all ", length(to_fetch), " persons...")
  } else {
    cutoff <- as.character(Sys.Date() - as.integer(refresh_days))
    to_fetch <- DBI::dbGetQuery(con, "
      SELECT p.short_id
      FROM persons p
      LEFT JOIN person_wikidata pw ON pw.short_id = p.short_id
      WHERE pw.short_id IS NULL OR pw.fetched_date < CAST(? AS DATE)
    ", params = list(cutoff))$short_id

    n_total <- DBI::dbGetQuery(con, "SELECT COUNT(*) FROM persons")[[1]]
    if (length(to_fetch) == 0) {
      info("✓ person_wikidata up to date (all ", n_total, " persons fresh within ", refresh_days, " days)")
      return(invisible(0L))
    }
    info(
      "Querying Wikidata for ", length(to_fetch), " new/stale persons ",
      "(", n_total - length(to_fetch), " already fresh)..."
    )
  }

  batches   <- split(to_fetch, ceiling(seq_along(to_fetch) / WIKIDATA_BATCH_SIZE))
  n_batches <- length(batches)

  all_rows <- purrr::imap_dfr(batches, function(batch, i) {
    i <- as.integer(i)
    if (i == 1L || i %% 50L == 0L) info("  Batch ", i, "/", n_batches)
    result <- tryCatch(
      fetch_wikidata_batch(batch),
      error = function(e) {
        warning("Batch ", i, " failed: ", e$message)
        tibble::tibble()
      }
    )
    Sys.sleep(1)
    result
  })

  found <- nrow(all_rows)

  if (found > 0) {
    DBI::dbWriteTable(con, "_wd_upsert_ids",
                      data.frame(short_id = all_rows$short_id),
                      overwrite = TRUE, temporary = TRUE)
    DBI::dbExecute(con, "DELETE FROM person_wikidata WHERE short_id IN (SELECT short_id FROM _wd_upsert_ids)")
    DBI::dbExecute(con, "DROP TABLE IF EXISTS _wd_upsert_ids")
    DBI::dbAppendTable(con, "person_wikidata", all_rows)
  }

  info("✓ person_wikidata: upserted ", found, " rows (", length(to_fetch) - found, " had no Wikidata entry)")
  invisible(found)
}
