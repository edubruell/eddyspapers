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

  # All workplaces with their Workplace-Share weights (13% of persons are
  # multi-affiliated). The persons table keeps the first workplace as before;
  # the full set feeds person_workplaces for EDIRC joins. The typed prototype
  # keeps zero-workplace persons from producing a column-less tibble.
  workplace_proto <- tibble::tibble(
    edi_handle = character(), name = character(),
    share = numeric(), rank = integer()
  )
  workplaces <- purrr::imap(entry$workplace %||% list(), function(wp, i) {
    tibble::tibble(
      edi_handle = get_field_safe(wp, "institution"),
      name       = get_field_safe(wp, "name"),
      share      = suppressWarnings(as.numeric(get_field_safe(wp, "share", NA_character_))),
      rank       = as.integer(i)
    )
  }) |>
    purrr::list_rbind(ptype = workplace_proto) |>
    dplyr::filter(nchar(edi_handle) > 0 | nchar(name) > 0)

  workplace_name        <- if (nrow(workplaces) > 0) workplaces$name[1] else ""
  workplace_institution <- if (nrow(workplaces) > 0) workplaces$edi_handle[1] else ""

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
    works                 = list(works),
    workplaces            = list(workplaces)
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
  migrate_schema(con)

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

  # Older persons_raw.rds files (pre-M8) lack the workplaces element; the
  # table then stays empty until the next parse_all_persons run.
  workplaces_df <- persons_raw |>
    purrr::map_dfr(~{
      wp <- .x$workplaces
      if (is.null(wp) || nrow(wp[[1]]) == 0) return(tibble::tibble())
      dplyr::mutate(wp[[1]], short_id = .x$short_id)
    })

  DBI::dbExecute(con, "DELETE FROM person_workplaces")
  if (nrow(workplaces_df) > 0) {
    # edi_handle lowercased at load so it joins institutions.edi_handle directly
    # (persons.workplace_institution keeps the registered original case).
    workplaces_df <- workplaces_df |>
      dplyr::transmute(short_id, edi_handle = tolower(edi_handle), name, share, rank)
    DBI::dbAppendTable(con, "person_workplaces", workplaces_df)
  }
  info("Inserted ", nrow(workplaces_df), " rows into person_workplaces")

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

