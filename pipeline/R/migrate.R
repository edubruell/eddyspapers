#' Schema migrations
#'
#' Ordered, named groups of idempotent DDL statements. Every statement must be
#' safe to re-run against any database state (ADD COLUMN IF NOT EXISTS /
#' CREATE TABLE IF NOT EXISTS), because a DB restored from parquet loses
#' schema_meta and replays the full list.
schema_migrations <- function() {
  list(
    m8_wave1 = c(
      "ALTER TABLE articles ADD COLUMN IF NOT EXISTS doi VARCHAR",
      "ALTER TABLE articles ADD COLUMN IF NOT EXISTS doi_source VARCHAR",
      "CREATE TABLE IF NOT EXISTS article_jel (
         handle   VARCHAR,
         jel_code VARCHAR
       )",
      "CREATE INDEX IF NOT EXISTS idx_article_jel_handle ON article_jel(handle)",
      "CREATE INDEX IF NOT EXISTS idx_article_jel_code   ON article_jel(jel_code)",
      "CREATE TABLE IF NOT EXISTS jel_codes (
         code   VARCHAR PRIMARY KEY,
         label  VARCHAR,
         level  INTEGER,
         parent VARCHAR
       )",
      "CREATE TABLE IF NOT EXISTS institutions (
         edi_handle     VARCHAR PRIMARY KEY,
         primary_name   VARCHAR,
         secondary_name VARCHAR,
         tertiary_name  VARCHAR,
         display_name   VARCHAR,
         location_raw   VARCHAR,
         country        VARCHAR,
         url            VARCHAR
       )",
      "CREATE TABLE IF NOT EXISTS person_workplaces (
         short_id   VARCHAR,
         edi_handle VARCHAR,
         name       VARCHAR,
         share      DOUBLE,
         rank       INTEGER
       )",
      "CREATE INDEX IF NOT EXISTS idx_pwp_short_id ON person_workplaces(short_id)",
      "CREATE INDEX IF NOT EXISTS idx_pwp_edi      ON person_workplaces(edi_handle)",
      "CREATE TABLE IF NOT EXISTS journal_quality (
         series_handle           VARCHAR PRIMARY KEY,
         n_items                 INTEGER,
         simple_if               DOUBLE,
         recursive_if            DOUBLE,
         discounted_if           DOUBLE,
         discounted_recursive_if DOUBLE,
         h_index                 INTEGER,
         euclid_score            DOUBLE,
         series_type             VARCHAR,
         series_name             VARCHAR,
         simple_if_10y           DOUBLE,
         recursive_if_10y        DOUBLE,
         h_index_10y             INTEGER,
         fetched_at              TIMESTAMP
       )"
    )
  )
}

#' Bring a database up to the current schema
#'
#' Applies all pending schema migrations in order and records them in
#' schema_meta. Safe to call from every entry point that opens the DB
#' read-write (cron populate, diff apply, patch apply, parquet restore) —
#' already-applied migrations re-run their idempotent DDL as a no-op when
#' schema_meta was lost (e.g. after restore_db_from_parquet).
#'
#' @param con DuckDB connection (read-write)
#' @return Character vector of migration ids applied this call (invisibly)
#' @export
migrate_schema <- function(con) {
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS schema_meta (
      migration_id VARCHAR PRIMARY KEY,
      applied_at   TIMESTAMP
    )
  ")

  recorded <- DBI::dbGetQuery(con, "SELECT migration_id FROM schema_meta")$migration_id
  migrations <- schema_migrations()

  applied <- purrr::imap(migrations, function(statements, id) {
    purrr::walk(statements, ~DBI::dbExecute(con, .x))
    if (!id %in% recorded) {
      DBI::dbExecute(
        con,
        "INSERT INTO schema_meta (migration_id, applied_at) VALUES (?, ?)",
        params = list(id, Sys.time())
      )
      info("Applied schema migration: ", id)
      id
    } else {
      NULL
    }
  }) |>
    purrr::compact() |>
    unlist()

  invisible(applied %||% character(0))
}
