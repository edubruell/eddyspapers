# OpenAlex works-metrics enrichment (Wave 2, Track B) -----------------------
#
# Now that the corpus carries DOIs (Wave 1 url/redif + Wave 2 container), we
# enrich every DOI'd paper with OpenAlex work-level metrics — global citation
# count, FWCI + percentile, retraction flag, open-access status, primary topic,
# venue/ISSN, funders — from the free CC0 S3 parquet snapshot (the API is paid;
# see 04_tiered_doi.md). The join key is the DOI, so this covers the whole DOI'd
# corpus, not just the 75 container journals Track A resolved by name.
#
# The snapshot `works` table (~510M rows / 725 GB) is partitioned by
# `updated_date`, not venue or DOI, so there is no cheap prefix filter: every
# partition must be scanned, projecting only the metric leaves and keeping the
# rows whose (resolver-stripped, lowercased) DOI is in the corpus set. The scan
# is chunked by part-file group and driven by a processx watchdog that survives
# the dead-socket S3 stalls httpfs is prone to (see `pull_openalex_metrics`).

# --- Corpus DOI set ---------------------------------------------------------

#' Export the corpus's distinct DOIs to a parquet
#'
#' The DOI-keyed pull filters the snapshot against this set. DOIs are already
#' normalized (lowercase, resolver-stripped) in `articles.doi`; this just dumps
#' the distinct non-null values.
#'
#' @param out_path Destination parquet path
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @return `out_path` (invisibly)
#' @export
export_corpus_dois <- function(out_path, db_path = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, sprintf(
    "COPY (SELECT DISTINCT lower(doi) AS doi FROM articles WHERE doi IS NOT NULL)
     TO '%s' (FORMAT parquet)", out_path))
  info("Exported corpus DOIs -> ", out_path)
  invisible(out_path)
}

# --- Metric projection (single source of truth) -----------------------------

# The flat metric projection over a works relation. Nested structs are pulled
# apart into scalar columns; the two genuinely list-shaped fields
# (counts_by_year, funders) are serialized to JSON strings so the resulting
# table stays flat and trivially readable by the Hono service. DOI is
# resolver-stripped + lowercased to match `articles.doi`.
oa_metrics_select_sql <- function() {
  "SELECT
     id AS openalex_id,
     lower(regexp_replace(doi,'^https?://(www\\.|dx\\.)?doi\\.org/','')) AS doi,
     cited_by_count::INTEGER AS oa_cited_by_count,
     is_retracted,
     fwci,
     citation_normalized_percentile.value                AS pctl_value,
     citation_normalized_percentile.is_in_top_1_percent  AS is_top1,
     citation_normalized_percentile.is_in_top_10_percent AS is_top10,
     open_access.is_oa     AS is_oa,
     open_access.oa_status AS oa_status,
     open_access.oa_url    AS oa_url,
     primary_topic.display_name       AS primary_topic,
     primary_topic.field.display_name AS primary_field,
     to_json(counts_by_year) AS counts_by_year,
     to_json(list_transform(funders, f -> {id: f.id, display_name: f.display_name, ror: f.ror})) AS funders,
     primary_location.source.display_name AS venue,
     primary_location.source.issn_l       AS issn_l,
     referenced_works_count::INTEGER AS referenced_works_count,
     publication_year AS oa_year,
     updated_date"
}

# The full COPY statement for one chunk — single source of truth for the pull
# SQL, shared by the in-process worker and the spawned watchdog worker (which
# receives it as a file and stays package-free). Writes to `out_tmp`; the caller
# renames to the final path on success.
oa_meta_copy_sql <- function(globs, out_tmp, dois_path) {
  globlist <- paste(sprintf("'%s'", globs), collapse = ",")
  sprintf("COPY (
    WITH src AS (%s
      FROM read_parquet([%s], filename=false)
      WHERE type IN ('article','review') AND doi IS NOT NULL)
    SELECT * FROM src WHERE doi IN (SELECT doi FROM read_parquet('%s'))
  ) TO '%s' (FORMAT parquet)",
    oa_metrics_select_sql(), globlist, dois_path, out_tmp)
}

# Configure a fresh DuckDB connection for the pull worker: httpfs, anonymous S3,
# short timeouts and few threads (fewer concurrent connections = fewer
# dead-socket stalls).
oa_pull_con <- function(threads = 4L) {
  con <- DBI::dbConnect(duckdb::duckdb())
  DBI::dbExecute(con, "INSTALL httpfs; LOAD httpfs;")
  DBI::dbExecute(con, "SET s3_region='us-east-1';")
  DBI::dbExecute(con, "SET http_timeout=30000; SET http_retries=3;")
  DBI::dbExecute(con, sprintf("SET threads=%d;", as.integer(threads)))
  try(DBI::dbExecute(con,
    "CREATE SECRET oa (TYPE s3, PROVIDER config, KEY_ID '', SECRET '');"),
    silent = TRUE)
  con
}

#' Pull one works-part-file chunk's metrics into a local parquet
#'
#' Scans the given part-file globs over httpfs, projects the flat metric columns
#' (`oa_metrics_select_sql`), keeps only rows whose DOI is in `dois_path`, and
#' writes to `out` via a `.tmp` + atomic rename so an interrupted scan never
#' leaves a half file that looks complete. This is the in-process form used in
#' tests; `pull_openalex_metrics` runs the same SQL in a watchdog subprocess.
#'
#' @param globs Character vector of S3 parquet globs/paths
#' @param out Destination parquet path
#' @param dois_path Corpus DOI parquet from `export_corpus_dois()`
#' @param threads DuckDB threads (fewer = fewer concurrent S3 connections =
#'   fewer dead-socket stalls). Default 4
#' @return `out` (invisibly)
#' @export
pull_oa_meta_worker <- function(globs, out, dois_path, threads = 4L) {
  con <- oa_pull_con(threads)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  tmp <- paste0(out, ".tmp")
  DBI::dbExecute(con, oa_meta_copy_sql(globs, tmp, dois_path))
  file.rename(tmp, out)
  invisible(out)
}

# List every works part file and group into pull chunks. A single S3 glob of
# the whole works tree returns all part paths cheaply; we bucket them by
# updated_date partition and split each partition into <= files_per_chunk
# groups, so the three giant single-day re-dumps (~1000 files each) become many
# bounded chunks while ordinary days stay whole. Bounding the chunk size bounds
# the blast radius of any one stall.
oa_meta_chunks <- function(con, files_per_chunk = 60L) {
  files <- DBI::dbGetQuery(con, sprintf(
    "SELECT file FROM glob('%s/works/updated_date=*/*.parquet') ORDER BY file",
    OA_S3_PARQUET))$file
  part <- sub(".*updated_date=([^/]+)/.*", "\\1", files)
  split(files, part) |>
    purrr::imap(function(fs, day) {
      groups <- split(fs, (seq_along(fs) - 1L) %/% files_per_chunk)
      purrr::imap(groups, ~list(
        name = if (length(groups) > 1) sprintf("%s-b%s", day, .y) else day,
        globs = .x))
    }) |>
    unlist(recursive = FALSE) |>
    unname()
}

# Shared watchdog runner for any snapshot pull. For each {name, globs} chunk it
# writes the COPY SQL (built by `sql_of(globs, out_tmp)`) to a file, runs it in a
# short-lived `processx` worker, polls for the chunk's atomically-renamed output
# and, on a `deadline_s` timeout, hard-kills the worker and retries on a fresh
# process WITHOUT waiting for the reap — httpfs S3 reads intermittently stall on
# a dead TCP connection that neither `http_timeout` nor SIGKILL clears promptly,
# and waiting for the reap is what turned earlier pulls into multi-hour hangs.
# The worker (`pull_oa_meta_chunk.R`) is SQL-agnostic, so any projection/filter
# reuses this identical stall-proof loop. Completed chunks are skipped on resume.
oa_pull_chunks <- function(chunks, out_dir, sql_of, deadline_s = 300,
                           retries = 8L, threads = 4L) {
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  worker <- system.file("scripts", "pull_oa_meta_chunk.R",
                        package = "eddyspapersbackend")
  if (!nzchar(worker)) stop("pull_oa_meta_chunk.R worker script not found")
  sql_dir <- file.path(out_dir, ".sql"); dir.create(sql_dir, showWarnings = FALSE)
  info(length(chunks), " chunks -> ", out_dir)

  for (ch in chunks) {
    out <- file.path(out_dir, paste0(ch$name, ".parquet"))
    if (file.exists(out)) { info("  skip ", ch$name, " (exists)"); next }
    tmp <- paste0(out, ".tmp")
    sql_file <- file.path(sql_dir, paste0(ch$name, ".sql"))
    writeLines(sql_of(ch$globs, tmp), sql_file)
    ok <- FALSE
    for (attempt in seq_len(retries)) {
      if (file.exists(out)) { ok <- TRUE; break }  # a prior attempt may have raced past the deadline
      if (file.exists(tmp)) file.remove(tmp)
      # Self-contained worker: setup con, run the chunk SQL, rename tmp -> out.
      # Discard the worker's std streams — completion is signalled by the atomic
      # rename, so an unread pipe filling on a long scan can never wedge it.
      p <- processx::process$new(
        file.path(R.home("bin"), "Rscript"),
        c(worker, sql_file, out, threads),
        stdout = NULL, stderr = NULL)
      t0 <- Sys.time()
      repeat {
        if (file.exists(out)) { ok <- TRUE; break }
        if (!p$is_alive()) break
        if (as.numeric(Sys.time() - t0, units = "secs") > deadline_s) break
        Sys.sleep(5)
      }
      if (ok) { info("  done ", ch$name, " (a", attempt, ")"); break }
      p$kill()  # deadline or dead worker: kill and retry, do NOT wait for reap
      info("  retry ", ch$name, " (a", attempt, ")")
    }
    if (!ok) warn("  GAVE UP ", ch$name)
  }
  invisible(out_dir)
}

#' Pull OpenAlex work metrics for the corpus DOIs into local parquet
#'
#' Sweeps the whole `works` snapshot (partitioned by `updated_date`), projecting
#' the flat metric columns and keeping only rows whose DOI is in the corpus set,
#' via the shared stall-proof watchdog runner (`oa_pull_chunks`). Completed
#' chunks are skipped on resume.
#'
#' @param dois_path Corpus DOI parquet from `export_corpus_dois()`
#' @param out_dir Directory for per-chunk parquet files
#' @param files_per_chunk Max part files per chunk (default 60)
#' @param deadline_s Per-attempt watchdog deadline in seconds (default 300)
#' @param retries Max attempts per chunk (default 8)
#' @param threads DuckDB threads per worker (default 4)
#' @param con Optional DuckDB connection for the file listing
#' @return `out_dir` (invisibly)
#' @export
pull_openalex_metrics <- function(dois_path, out_dir, files_per_chunk = 60L,
                                  deadline_s = 300, retries = 8L, threads = 4L,
                                  con = NULL) {
  if (is.null(con)) {
    con <- DBI::dbConnect(duckdb::duckdb())
    oa_s3_setup(con)
    on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  }
  dois_path <- normalizePath(dois_path, winslash = "/", mustWork = TRUE)
  chunks <- oa_meta_chunks(con, files_per_chunk)
  info("OpenAlex metrics pull: ", length(chunks), " chunks")
  oa_pull_chunks(chunks, out_dir,
    sql_of = function(globs, tmp) oa_meta_copy_sql(globs, tmp, dois_path),
    deadline_s = deadline_s, retries = retries, threads = threads)
}

# --- Build the article_openalex table ---------------------------------------

#' Build the `article_openalex` rows from the pulled metrics
#'
#' Joins every DOI'd corpus paper to its OpenAlex work by DOI. A DOI can occur
#' in several `updated_date` partitions (the giant re-dumps overlap the daily
#' ones); the freshest row (max `updated_date`) wins. A DOI can also map to
#' several corpus handles (paper versions / duplicate RePEc handles) — each
#' handle gets that work's metrics, keyed by handle.
#'
#' @param meta_glob Local metrics parquet glob from `pull_openalex_metrics()`
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @return Tibble of `article_openalex` rows (one per handle)
#' @export
build_article_openalex <- function(meta_glob, db_path = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, sprintf("ATTACH '%s' AS corp (READ_ONLY);", db_path))
  res <- DBI::dbGetQuery(con, sprintf("
    WITH m AS (
      SELECT *, row_number() OVER (
               PARTITION BY doi ORDER BY updated_date DESC, oa_cited_by_count DESC) rn
      FROM read_parquet('%s')),
      best AS (SELECT * FROM m WHERE rn = 1)
    SELECT a.Handle AS handle, b.openalex_id, b.doi,
           b.oa_cited_by_count::INTEGER AS oa_cited_by_count,
           b.fwci, b.pctl_value, b.is_top1, b.is_top10,
           b.is_retracted, b.is_oa, b.oa_status, b.oa_url,
           b.primary_topic, b.primary_field, b.counts_by_year, b.funders,
           b.venue, b.issn_l,
           b.referenced_works_count::INTEGER AS referenced_works_count,
           b.oa_year, b.updated_date
    FROM corp.articles a
    JOIN best b ON lower(a.doi) = b.doi
    WHERE a.doi IS NOT NULL", meta_glob))
  tibble::as_tibble(res)
}

#' Write the `article_openalex` replace-table patch
#'
#' Builds the table and emits a `replace_table` patch (schema comes from the
#' parquet; `migrate_schema` restores the indices after apply). Ship it with the
#' standard backfill flow: `run_backfill()` (apply + baseline dump) then
#' `deploy_patches.sh`.
#'
#' @param meta_glob Local metrics parquet glob from `pull_openalex_metrics()`
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param pqt_patch_folder Patch folder. Defaults to config$pqt_patch_folder
#' @return Path to the patch manifest (invisibly)
#' @export
openalex_metrics_patch <- function(meta_glob, db_path = NULL, pqt_patch_folder = NULL) {
  rows <- build_article_openalex(meta_glob, db_path)
  info("article_openalex: ", nrow(rows), " handle rows")
  write_patch(rows, target_table = "article_openalex", mode = "replace_table",
              pqt_patch_folder = pqt_patch_folder)
}
