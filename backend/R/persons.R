get_field_safe <- function(entry, field, default = "") {
  val <- entry[[field]]
  if (is.null(val) || length(val) == 0) return(default)
  out <- val[[1]]
  if (is.null(out) || length(out) == 0) default else out
}

#' Post-process a parsed ReDIF-Person entry
#'
#' Extracts and cleans fields from a parsed ReDIF-Person 1.0 entry.
#'
#' @param entry Parsed entry list from parse_redif_perl
#' @return Named list with scalar person fields and a works tibble, or NULL if invalid
#' @export
post_process_person_entry <- function(entry) {
  if (is.null(entry$TYPE) || entry$TYPE != "ReDIF-Person 1.0") return(NULL)

  short_id <- get_field_safe(entry, "short-id", "")
  if (nchar(short_id) == 0) return(NULL)

  workplace_name        <- ""
  workplace_institution <- ""
  if (!is.null(entry$workplace) && length(entry$workplace) > 0) {
    wp <- entry$workplace[[1]]
    if (!is.null(wp$name) && length(wp$name) > 0)
      workplace_name <- wp$name[[1]]
    if (!is.null(wp$institution) && length(wp$institution) > 0)
      workplace_institution <- wp$institution[[1]]
  }

  work_field_map <- c(
    "author-paper"    = "paper",
    "author-article"  = "article",
    "author-chapter"  = "chapter",
    "author-software" = "software",
    "author-book"     = "book",
    "editor-book"     = "editor-book",
    "editor-series"   = "editor-series"
  )

  works <- purrr::map_dfr(names(work_field_map), function(field) {
    handles <- entry[[field]]
    if (is.null(handles) || length(handles) == 0)
      return(tibble::tibble(work_handle = character(), work_type = character()))
    tibble::tibble(
      work_handle = tolower(unlist(handles)),
      work_type   = work_field_map[[field]]
    )
  }) |>
    dplyr::filter(!is.na(work_handle), nchar(work_handle) > 0)

  list(
    short_id              = short_id,
    handle                = if (!is.null(entry$ID)) entry$ID else "",
    name_first            = get_field_safe(entry, "name-first"),
    name_last             = get_field_safe(entry, "name-last"),
    name_full             = get_field_safe(entry, "name-full"),
    workplace_name        = workplace_name,
    workplace_institution = workplace_institution,
    homepage              = get_field_safe(entry, "homepage"),
    registered_date       = get_field_safe(entry, "registered-date", NA_character_),
    last_login_date       = get_field_safe(entry, "last-login-date", NA_character_),
    works                 = list(works)
  )
}


#' Parse all person RDF files from the pers archive
#'
#' Uses the directory-aware Perl ReDIF parser to process the entire pers archive
#' in one pass and saves the result as a single RDS file.
#'
#' @param repec_folder Path to the root RepEC folder. Defaults to config$repec_folder
#' @param rds_persons_folder Output folder for the persons RDS. Defaults to config$rds_persons_folder
#' @param script_path Path to parse_redif_dir.pl. Defaults to the bundled script
#' @return Parsed persons tibble (invisibly)
#' @export
parse_all_persons <- function(repec_folder     = NULL,
                              rds_persons_folder = NULL,
                              script_path      = NULL) {
  if (is.null(repec_folder)) {
    config <- get_folder_config()
    repec_folder <- config$repec_folder
  }
  if (is.null(rds_persons_folder)) {
    config <- get_folder_config()
    rds_persons_folder <- config$rds_persons_folder
  }
  if (is.null(script_path)) {
    script_path <- system.file(
      "scripts", "parse_redif_dir.pl",
      package = "eddyspapersbackend"
    )
    if (script_path == "") stop("Could not find parse_redif_dir.pl in package")
  }

  pers_dir <- file.path(repec_folder, "per", "pers")
  if (!dir.exists(pers_dir)) stop("pers directory not found: ", pers_dir)

  if (!dir.exists(rds_persons_folder))
    dir.create(rds_persons_folder, recursive = TRUE, showWarnings = FALSE)

  perl_bin <- Sys.which("perl")
  if (perl_bin == "") stop("No perl executable found on PATH")

  info("Parsing pers archive: ", pers_dir)
  res <- processx::run(
    command         = perl_bin,
    args            = c(script_path, pers_dir),
    error_on_status = TRUE,
    timeout         = 600
  )

  output    <- strsplit(res$stdout, "\n", fixed = TRUE)[[1]]
  json_start <- which(stringr::str_detect(output, "^\\s*\\["))[1]
  json_end   <- tail(which(stringr::str_detect(output, "^\\s*\\]")), 1)

  if (is.na(json_start) || is.na(json_end) || json_end < json_start) {
    stop("No valid JSON array in Perl output.\n", res$stderr)
  }

  json_txt <- paste(output[json_start:json_end], collapse = "\n")
  raw      <- jsonlite::fromJSON(json_txt, simplifyVector = FALSE)

  info("Processing ", length(raw), " person entries...")

  persons_raw <- raw |>
    purrr::map(post_process_person_entry) |>
    purrr::compact()

  info("Valid entries after processing: ", length(persons_raw))

  saveRDS(persons_raw, file.path(rds_persons_folder, "persons_raw.rds"))
  info("Saved persons_raw.rds to: ", rds_persons_folder)

  invisible(persons_raw)
}


#' Initialize person tables in DuckDB
#'
#' Creates persons, person_works, and person_stats tables if they do not exist.
#'
#' @param con DuckDB connection
#' @return TRUE invisibly
#' @export
init_persons_tables <- function(con) {
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS persons (
      short_id              VARCHAR PRIMARY KEY,
      name_first            VARCHAR,
      name_last             VARCHAR,
      name_full             VARCHAR,
      workplace_name        VARCHAR,
      workplace_institution VARCHAR,
      homepage              VARCHAR,
      handle                VARCHAR,
      registered_date       DATE,
      last_login_date       DATE
    )
  ")

  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS person_works (
      short_id    VARCHAR,
      work_handle VARCHAR,
      work_type   VARCHAR
    )
  ")

  DBI::dbExecute(con, "
    CREATE INDEX IF NOT EXISTS idx_pw_short_id ON person_works(short_id)
  ")

  DBI::dbExecute(con, "
    CREATE INDEX IF NOT EXISTS idx_pw_handle ON person_works(work_handle)
  ")

  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS person_stats (
      short_id          VARCHAR PRIMARY KEY,
      n_works_total     INTEGER,
      n_works_in_corpus INTEGER,
      total_citations   INTEGER,
      a_count           INTEGER,
      first_year        INTEGER,
      last_year         INTEGER,
      primary_category  VARCHAR
    )
  ")

  invisible(TRUE)
}


#' Populate person tables from parsed persons RDS
#'
#' Full replace of persons and person_works tables on every run.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param rds_persons_folder Folder containing persons_raw.rds. Defaults to config$rds_persons_folder
#' @return Number of persons inserted (invisibly)
#' @export
populate_persons <- function(db_path = NULL, rds_persons_folder = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  if (is.null(rds_persons_folder)) {
    config <- get_folder_config()
    rds_persons_folder <- config$rds_persons_folder
  }

  rds_path <- file.path(rds_persons_folder, "persons_raw.rds")
  if (!file.exists(rds_path)) stop("persons_raw.rds not found: ", rds_path)

  persons_raw <- readRDS(rds_path)
  info("Loaded ", length(persons_raw), " person entries from RDS")

  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con), add = TRUE)

  DBI::dbExecute(con, "DROP TABLE IF EXISTS person_works")
  DBI::dbExecute(con, "DROP TABLE IF EXISTS persons")
  DBI::dbExecute(con, "DROP TABLE IF EXISTS person_stats")
  init_persons_tables(con)

  persons_df <- persons_raw |>
    purrr::map_dfr(~tibble::tibble(
      short_id              = .x$short_id,
      name_first            = .x$name_first,
      name_last             = .x$name_last,
      name_full             = .x$name_full,
      workplace_name        = .x$workplace_name,
      workplace_institution = .x$workplace_institution,
      homepage              = .x$homepage,
      handle                = .x$handle,
      registered_date       = tryCatch(as.Date(.x$registered_date), error = function(e) as.Date(NA)),
      last_login_date       = tryCatch(as.Date(.x$last_login_date),  error = function(e) as.Date(NA))
    ))

  DBI::dbAppendTable(con, "persons", persons_df)
  info("Inserted ", nrow(persons_df), " rows into persons")

  works_df <- persons_raw |>
    purrr::map_dfr(~{
      w <- .x$works[[1]]
      if (nrow(w) == 0) return(tibble::tibble())
      dplyr::mutate(w, short_id = .x$short_id)
    }) |>
    dplyr::select(short_id, work_handle, work_type)

  DBI::dbAppendTable(con, "person_works", works_df)
  info("Inserted ", nrow(works_df), " rows into person_works")

  invisible(nrow(persons_df))
}


#' Compute precomputed person statistics
#'
#' Joins person_works to articles and handle_stats to derive impact metrics
#' per registered author. Drops and recreates person_stats on every call.
#'
#' @param con DuckDB connection (must have persons, person_works, articles, handle_stats)
#' @return Number of persons with computed stats (invisibly)
#' @export
compute_person_stats <- function(con) {
  info("Computing person_stats...")

  DBI::dbExecute(con, "DROP TABLE IF EXISTS person_stats")
  DBI::dbExecute(con, "
    CREATE TABLE person_stats (
      short_id          VARCHAR PRIMARY KEY,
      n_works_total     INTEGER,
      n_works_in_corpus INTEGER,
      total_citations   INTEGER,
      a_count           INTEGER,
      first_year        INTEGER,
      last_year         INTEGER,
      primary_category  VARCHAR
    )
  ")

  info("  Step 1/5: total work counts")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW ps_total_works AS
    SELECT short_id, COUNT(*) AS n_works_total
    FROM person_works
    GROUP BY short_id
  ")

  info("  Step 2/5: corpus works")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW ps_corpus_works AS
    SELECT pw.short_id,
           pw.work_handle,
           a.year,
           a.category,
           a.journal
    FROM person_works pw
    JOIN articles a ON LOWER(a.Handle) = pw.work_handle
  ")

  info("  Step 3/5: corpus counts + year range")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW ps_corpus_counts AS
    SELECT short_id,
           COUNT(*)   AS n_works_in_corpus,
           MIN(year)  AS first_year,
           MAX(year)  AS last_year
    FROM ps_corpus_works
    GROUP BY short_id
  ")

  info("  Step 4/5: citation and journal tier sums")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW ps_citation_sums AS
    SELECT cw.short_id,
           COALESCE(SUM(hs.total_citations), 0)                                              AS total_citations,
           COALESCE(SUM(CASE WHEN cw.category = 'Top Field Journals (A)' THEN 1 ELSE 0 END), 0) AS a_count
    FROM ps_corpus_works cw
    LEFT JOIN handle_stats hs ON LOWER(hs.handle) = cw.work_handle
    GROUP BY cw.short_id
  ")

  info("  Step 5/5: primary category (modal)")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW ps_primary_cat AS
    SELECT short_id, category AS primary_category
    FROM (
      SELECT short_id, category,
             ROW_NUMBER() OVER (PARTITION BY short_id ORDER BY n DESC, category) AS rn
      FROM (
        SELECT short_id, category, COUNT(*) AS n
        FROM ps_corpus_works
        GROUP BY short_id, category
      ) cat_counts
    ) ranked
    WHERE rn = 1
  ")

  DBI::dbExecute(con, "
    INSERT INTO person_stats
    SELECT
      p.short_id,
      COALESCE(tw.n_works_total,     0) AS n_works_total,
      COALESCE(cc.n_works_in_corpus, 0) AS n_works_in_corpus,
      COALESCE(cs.total_citations,   0) AS total_citations,
      COALESCE(cs.a_count,           0) AS a_count,
      cc.first_year,
      cc.last_year,
      pc.primary_category
    FROM persons p
    LEFT JOIN ps_total_works   tw ON tw.short_id = p.short_id
    LEFT JOIN ps_corpus_counts cc ON cc.short_id = p.short_id
    LEFT JOIN ps_citation_sums cs ON cs.short_id = p.short_id
    LEFT JOIN ps_primary_cat   pc ON pc.short_id = p.short_id
  ")

  purrr::walk(
    c("ps_total_works", "ps_corpus_works", "ps_corpus_counts",
      "ps_citation_sums", "ps_primary_cat"),
    ~DBI::dbExecute(con, sprintf("DROP VIEW IF EXISTS %s", .x))
  )

  count <- DBI::dbGetQuery(con, "SELECT COUNT(*) AS n FROM person_stats")$n
  info("✓ person_stats computed for ", count, " persons")
  invisible(count)
}


#' Two-stage person search: topic query → ranked authors
#'
#' Stage 1: HNSW vector search on articles (hidden, large K).
#' Stage 2: roll up matched papers to authors via person_works, blend with quality signal.
#' Version duplicates (same title, different repos) are deduplicated before scoring.
#'
#' @param query Natural-language search query
#' @param k_papers Stage-1 paper pool size (default 1000)
#' @param quality_weight Citation prominence blend; 0 = off, 0.3 = default
#' @param scoring_mode How to weight relevance: "breadth" (total topic coverage, default),
#'   "best_match" (single highest-scoring paper), or "blended" (50/50 mix)
#' @param limit Authors to return (default 25)
#' @param offset Pagination offset (default 0)
#' @param filters Named list: min_year, category (character vector), institution,
#'   active_since, min_citations
#' @param pool Database pool. Defaults to get_api_pool()
#' @param model Ollama embedding model
#' @return Data frame of ranked authors with evidence
#' @export
search_persons <- function(query,
                           k_papers       = 1000,
                           quality_weight = 0.3,
                           scoring_mode   = "breadth",
                           limit          = 25,
                           offset         = 0,
                           filters        = list(),
                           pool           = NULL,
                           model          = "mxbai-embed-large") {
  scoring_mode <- match.arg(scoring_mode, c("breadth", "best_match", "blended"))
  if (is.null(pool)) pool <- get_api_pool()

  query_vec <- unlist(tidyllm::ollama_embedding(query, .model = model)$embeddings)

  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  stage1_filters <- c()
  if (!is.null(filters$min_year) && !is.na(filters$min_year))
    stage1_filters <- c(stage1_filters, sprintf("a.year >= %d", as.integer(filters$min_year)))
  if (!is.null(filters$category) && length(filters$category) > 0) {
    cats_sql <- paste(
      purrr::map_chr(filters$category, ~DBI::dbQuoteString(con, .x)),
      collapse = ", "
    )
    stage1_filters <- c(stage1_filters, sprintf("a.category IN (%s)", cats_sql))
  }

  where_clause <- if (length(stage1_filters) > 0)
    paste("WHERE", paste(stage1_filters, collapse = " AND "))
  else ""

  sql_stage1 <- sprintf("
    SELECT a.Handle, a.title, a.journal, a.year,
           array_cosine_distance(a.embeddings, ?::FLOAT[1024]) AS distance
    FROM articles a
    %s
    ORDER BY distance ASC
    LIMIT ?
  ", where_clause)

  DBI::dbExecute(con, "LOAD vss;")
  stmt <- DBI::dbSendQuery(con, sql_stage1)
  DBI::dbBind(stmt, list(list(query_vec), as.integer(k_papers)))
  hits <- DBI::dbFetch(stmt)
  DBI::dbClearResult(stmt)

  if (nrow(hits) == 0) return(tibble::tibble())

  hits$score       <- 1 - hits$distance
  hits$work_handle <- tolower(hits$Handle)

  DBI::dbExecute(con, "DROP TABLE IF EXISTS tmp_person_hits")
  DBI::dbExecute(con, "DROP TABLE IF EXISTS tmp_person_hits_dedup")
  DBI::dbExecute(con, "
    CREATE TEMP TABLE tmp_person_hits (
      work_handle VARCHAR,
      score       DOUBLE,
      title       VARCHAR,
      journal     VARCHAR,
      year        INTEGER
    )
  ")
  DBI::dbAppendTable(con, "tmp_person_hits",
    hits[, c("work_handle", "score", "title", "journal", "year")])

  # Deduplicate by normalised title so multiple repo versions of the same paper
  # count only once (highest-scoring handle kept per title group).
  DBI::dbExecute(con, "
    CREATE TEMP TABLE tmp_person_hits_dedup AS
    SELECT work_handle, score, title, journal, year
    FROM (
      SELECT work_handle, score, title, journal, year,
             ROW_NUMBER() OVER (
               PARTITION BY LOWER(TRIM(COALESCE(title, work_handle)))
               ORDER BY score DESC
             ) AS rn
      FROM tmp_person_hits
    ) t
    WHERE rn = 1
  ")
  DBI::dbExecute(con, "DROP TABLE IF EXISTS tmp_person_hits")

  stage2_sql <- "
    SELECT pw.short_id,
           SUM(h.score)                                          AS overlap_weight,
           COUNT(*)                                              AS n_matched,
           MAX(h.score)                                          AS best_score,
           LIST(h.work_handle ORDER BY h.score DESC)[1:5]       AS evidence_handles,
           LIST(h.title       ORDER BY h.score DESC)[1:5]       AS evidence_titles,
           LIST(h.journal     ORDER BY h.score DESC)[1:5]       AS evidence_journals,
           LIST(h.year        ORDER BY h.score DESC)[1:5]       AS evidence_years,
           LIST(h.score       ORDER BY h.score DESC)[1:5]       AS evidence_scores
    FROM tmp_person_hits_dedup h
    JOIN person_works pw ON pw.work_handle = h.work_handle
    GROUP BY pw.short_id
  "

  person_scores <- DBI::dbGetQuery(con, stage2_sql)
  DBI::dbExecute(con, "DROP TABLE IF EXISTS tmp_person_hits_dedup")

  if (nrow(person_scores) == 0) return(tibble::tibble())

  ids_sql <- paste(
    purrr::map_chr(person_scores$short_id, ~DBI::dbQuoteString(con, .x)),
    collapse = ", "
  )
  meta <- DBI::dbGetQuery(con, sprintf("
    SELECT p.short_id, p.name_full, p.workplace_name, p.workplace_institution,
           p.homepage,
           ps.n_works_in_corpus, ps.total_citations,
           ps.first_year, ps.last_year, ps.primary_category,
           pw.image_url
    FROM persons p
    LEFT JOIN person_stats ps ON ps.short_id = p.short_id
    LEFT JOIN person_wikidata pw ON pw.short_id = p.short_id
    WHERE p.short_id IN (%s)
  ", ids_sql))

  results <- dplyr::inner_join(person_scores, meta, by = "short_id")

  if (!is.null(filters$institution) && nchar(filters$institution) > 0)
    results <- dplyr::filter(results,
      !is.na(workplace_institution),
      tolower(workplace_institution) == tolower(filters$institution))

  if (!is.null(filters$active_since) && !is.na(filters$active_since))
    results <- dplyr::filter(results,
      !is.na(last_year), last_year >= as.integer(filters$active_since))

  if (!is.null(filters$min_citations) && !is.na(filters$min_citations))
    results <- dplyr::filter(results,
      !is.na(total_citations),
      total_citations >= as.integer(filters$min_citations))

  if (nrow(results) == 0) return(tibble::tibble())

  max_log_cit  <- max(log1p(results$total_citations), na.rm = TRUE)
  max_overlap  <- max(results$overlap_weight,          na.rm = TRUE)

  results <- results |>
    dplyr::mutate(
      quality_norm  = ifelse(max_log_cit > 0, log1p(total_citations) / max_log_cit, 0),
      quality_blend = 1 + quality_weight * quality_norm,
      overlap_norm  = ifelse(max_overlap  > 0, overlap_weight / max_overlap, 0),
      score = dplyr::case_when(
        scoring_mode == "best_match" ~ best_score  * quality_blend,
        scoring_mode == "blended"    ~ (0.5 * overlap_norm + 0.5 * best_score) * quality_blend,
        TRUE                         ~ overlap_weight * quality_blend
      )
    ) |>
    dplyr::arrange(dplyr::desc(score))

  end_row <- min(offset + limit, nrow(results))
  if (offset >= nrow(results)) return(tibble::tibble())
  results[(offset + 1):end_row, ]
}


#' Get a person profile by short_id
#'
#' Returns profile fields, stats, category breakdown, and top journals.
#'
#' @param short_id Author short identifier (e.g. "pac16")
#' @param pool Database pool. Defaults to get_api_pool()
#' @return List with profile data, or NULL if not found
#' @export
get_person_profile <- function(short_id, pool = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  person <- DBI::dbGetQuery(con, "
    SELECT p.*, ps.n_works_total, ps.n_works_in_corpus, ps.total_citations,
           ps.a_count, ps.first_year, ps.last_year, ps.primary_category,
           pw.wikidata_id, pw.wikipedia_url, pw.image_url,
           pw.birth_year, pw.birth_place,
           pw.citizenships, pw.educated_at, pw.doctoral_advisors,
           pw.doctoral_students, pw.fields_of_work, pw.memberships, pw.awards,
           pw.orcid, pw.google_scholar_id, pw.ssrn_author_id,
           pw.math_genealogy_id, pw.website
    FROM persons p
    LEFT JOIN person_stats ps ON ps.short_id = p.short_id
    LEFT JOIN person_wikidata pw ON pw.short_id = p.short_id
    WHERE p.short_id = ?
  ", params = list(short_id))

  if (nrow(person) == 0) return(NULL)

  cat_breakdown <- DBI::dbGetQuery(con, "
    SELECT a.category, COUNT(*) AS n
    FROM person_works pw
    JOIN articles a ON LOWER(a.Handle) = pw.work_handle
    WHERE pw.short_id = ?
    GROUP BY a.category
    ORDER BY n DESC
  ", params = list(short_id))

  top_journals <- DBI::dbGetQuery(con, "
    SELECT a.journal, COUNT(*) AS n
    FROM person_works pw
    JOIN articles a ON LOWER(a.Handle) = pw.work_handle
    WHERE pw.short_id = ?
    GROUP BY a.journal
    ORDER BY n DESC
    LIMIT 5
  ", params = list(short_id))

  editorial_roles <- DBI::dbGetQuery(con, "
    SELECT
      pw.work_handle  AS series_handle,
      pw.work_type    AS role,
      j.long_name     AS series_name,
      j.category
    FROM person_works pw
    JOIN journals j ON j.series_handle = pw.work_handle
    WHERE pw.short_id = ?
      AND pw.work_type IN ('editor-series', 'editor-book')
    ORDER BY pw.work_type, series_name
  ", params = list(short_id))

  wikidata <- if (!is.na(person$wikidata_id[[1]])) {
    list(
      wikidata_id       = person$wikidata_id[[1]],
      wikipedia_url     = person$wikipedia_url[[1]],
      image_url         = person$image_url[[1]],
      birth_year        = person$birth_year[[1]],
      birth_place       = person$birth_place[[1]],
      citizenships      = person$citizenships[[1]],
      educated_at       = person$educated_at[[1]],
      doctoral_advisors = person$doctoral_advisors[[1]],
      doctoral_students = person$doctoral_students[[1]],
      fields_of_work    = person$fields_of_work[[1]],
      memberships       = person$memberships[[1]],
      awards            = person$awards[[1]],
      orcid             = person$orcid[[1]],
      google_scholar_id = person$google_scholar_id[[1]],
      ssrn_author_id    = person$ssrn_author_id[[1]],
      math_genealogy_id = person$math_genealogy_id[[1]],
      website           = person$website[[1]]
    )
  } else {
    NULL
  }

  list(
    short_id              = person$short_id[[1]],
    name_full             = person$name_full[[1]],
    name_first            = person$name_first[[1]],
    name_last             = person$name_last[[1]],
    workplace_name        = person$workplace_name[[1]],
    workplace_institution = person$workplace_institution[[1]],
    homepage              = person$homepage[[1]],
    registered_date       = as.character(person$registered_date[[1]]),
    stats = list(
      n_works_total     = person$n_works_total[[1]],
      n_works_in_corpus = person$n_works_in_corpus[[1]],
      total_citations   = person$total_citations[[1]],
      a_count           = person$a_count[[1]],
      first_year        = person$first_year[[1]],
      last_year         = person$last_year[[1]],
      primary_category  = person$primary_category[[1]]
    ),
    wikidata           = wikidata,
    editorial_roles    = editorial_roles,
    category_breakdown = cat_breakdown,
    top_journals       = top_journals
  )
}


ensure_saved_person_searches_table <- function(pool = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS saved_person_searches (
      hash          VARCHAR PRIMARY KEY,
      query         TEXT NOT NULL,
      scoring_mode  VARCHAR,
      quality_weight DOUBLE,
      results       JSON NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  ")
  invisible(NULL)
}

#' Save a person search and return its hash
#'
#' @param query Natural-language query string
#' @param scoring_mode Scoring mode used ("breadth", "best_match", "blended")
#' @param quality_weight Citation blend weight used
#' @param results List of result rows (will be serialised to JSON)
#' @param pool Database pool. Defaults to get_api_pool()
#' @return 8-character hash string
#' @export
save_person_search <- function(query, scoring_mode, quality_weight, results, pool = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  ensure_saved_person_searches_table(pool)

  hash_input <- list(query = query, scoring_mode = scoring_mode, quality_weight = quality_weight)
  hash <- substr(digest::digest(hash_input, algo = "xxhash64"), 1, 8)

  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  existing <- DBI::dbGetQuery(con, "SELECT hash FROM saved_person_searches WHERE hash = ?", params = list(hash))
  if (nrow(existing) == 0) {
    DBI::dbExecute(con, "
      INSERT INTO saved_person_searches (hash, query, scoring_mode, quality_weight, results)
      VALUES (?, ?, ?, ?, ?)
    ", params = list(
      hash, query, scoring_mode, as.numeric(quality_weight),
      as.character(jsonlite::toJSON(results, auto_unbox = TRUE))
    ))
  }
  hash
}

#' Retrieve a saved person search by hash
#'
#' @param hash 8-character hash from save_person_search
#' @param pool Database pool. Defaults to get_api_pool()
#' @return List with search metadata and results, or NULL if not found
#' @export
get_saved_person_search <- function(hash, pool = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  row <- DBI::dbGetQuery(con, "SELECT * FROM saved_person_searches WHERE hash = ?", params = list(hash))
  if (nrow(row) == 0) return(NULL)

  list(
    hash          = row$hash[[1]],
    query         = row$query[[1]],
    scoring_mode  = row$scoring_mode[[1]],
    quality_weight = row$quality_weight[[1]],
    results       = jsonlite::fromJSON(row$results[[1]], simplifyVector = FALSE),
    created_at    = as.character(row$created_at[[1]])
  )
}


#' Get full publication list for a person
#'
#' Returns in-corpus papers (rich rows) and out-of-corpus handles (thin rows).
#'
#' @param short_id Author short identifier
#' @param sort_by Sort column for in-corpus papers: "year", "citations", "journal"
#' @param order "desc" or "asc"
#' @param include_out_of_corpus Include handles not in articles table (default TRUE)
#' @param limit Pagination limit (default 50)
#' @param offset Pagination offset (default 0)
#' @param pool Database pool. Defaults to get_api_pool()
#' @return List with in_corpus and out_of_corpus paper lists
#' @export
get_person_papers <- function(short_id,
                              sort_by               = "year",
                              order                 = "desc",
                              include_out_of_corpus = TRUE,
                              limit                 = 50,
                              offset                = 0,
                              pool                  = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  sort_col <- switch(sort_by,
    "citations" = "hs.total_citations",
    "journal"   = "a.journal",
    "a.year"
  )
  order_dir <- if (tolower(order) == "asc") "ASC" else "DESC"

  in_corpus <- DBI::dbGetQuery(con, sprintf("
    SELECT a.Handle AS handle, a.title, a.journal, a.year, a.category,
           a.abstract, a.bib_tex, a.authors, a.url, a.is_series,
           pw.work_type,
           COALESCE(hs.total_citations, 0) AS citations
    FROM person_works pw
    JOIN articles a ON LOWER(a.Handle) = pw.work_handle
    LEFT JOIN handle_stats hs ON LOWER(hs.handle) = pw.work_handle
    WHERE pw.short_id = ?
    ORDER BY %s %s NULLS LAST
    LIMIT ? OFFSET ?
  ", sort_col, order_dir),
    params = list(short_id, as.integer(limit), as.integer(offset)))

  counts <- DBI::dbGetQuery(con, "
    SELECT COUNT(*) AS n_total,
           SUM(CASE WHEN a.Handle IS NOT NULL THEN 1 ELSE 0 END) AS n_corpus
    FROM person_works pw
    LEFT JOIN articles a ON LOWER(a.Handle) = pw.work_handle
    WHERE pw.short_id = ?
  ", params = list(short_id))

  out_of_corpus <- tibble::tibble()
  if (include_out_of_corpus) {
    ooc_raw <- DBI::dbGetQuery(con, "
      SELECT pw.work_handle, pw.work_type
      FROM person_works pw
      LEFT JOIN articles a ON LOWER(a.Handle) = pw.work_handle
      WHERE pw.short_id = ? AND a.Handle IS NULL
    ", params = list(short_id))

    if (nrow(ooc_raw) > 0) {
      out_of_corpus <- ooc_raw |>
        dplyr::mutate(
          ideas_url = purrr::map2_chr(work_handle, work_type, handle_to_ideas_url)
        )
    }
  }

  list(
    short_id        = short_id,
    counts          = list(
      total          = counts$n_total[[1]],
      in_corpus      = counts$n_corpus[[1]],
      out_of_corpus  = counts$n_total[[1]] - counts$n_corpus[[1]]
    ),
    in_corpus       = in_corpus,
    out_of_corpus   = out_of_corpus
  )
}


#' Name lookup / autocomplete for persons
#'
#' Case-insensitive substring search over persons.name_full.
#'
#' @param name Search string
#' @param limit Maximum results (default 20)
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Data frame with short_id, name_full, workplace_name, n_works_in_corpus
#' @export
lookup_persons_by_name <- function(name, limit = 20, pool = NULL) {
  if (is.null(pool)) pool <- get_api_pool()
  con <- pool::poolCheckout(pool)
  on.exit(pool::poolReturn(con), add = TRUE)

  DBI::dbGetQuery(con, "
    SELECT p.short_id, p.name_full, p.workplace_name,
           COALESCE(ps.n_works_in_corpus, 0) AS n_works_in_corpus
    FROM persons p
    LEFT JOIN person_stats ps ON ps.short_id = p.short_id
    WHERE LOWER(p.name_full) LIKE LOWER(?)
    ORDER BY COALESCE(ps.total_citations, 0) DESC
    LIMIT ?
  ", params = list(paste0("%", name, "%"), as.integer(limit)))
}


handle_to_ideas_url <- function(handle, work_type) {
  prefix <- switch(work_type,
    "paper"         = "p",
    "article"       = "a",
    "chapter"       = "h",
    "book"          = "b",
    "software"      = "e",
    "editor-book"   = "b",
    "editor-series" = "s",
    "p"
  )
  path <- sub("^repec:", "", handle)
  path <- gsub(":", "/", path)
  paste0("https://ideas.repec.org/", prefix, "/", path, ".html")
}
