# Tests for the M8 generalized value-compare in compute_parquet_diffs (UPDATE
# rows for every keyed table with payload columns, not just articles) and the
# delete+insert UPDATE path in apply_parquet_diffs. Dumps are built as tiny
# parquet files via DuckDB COPY, named exactly like dump_db_to_parquet output
# ({table}_{stamp}.parquet).

if (!exists("compute_parquet_diffs", mode = "function")) {
  r_dir <- normalizePath(file.path(testthat::test_path(), "..", "..", "R"),
                         mustWork = FALSE)
  if (!dir.exists(r_dir)) {
    r_dir <- normalizePath(file.path("pipeline", "R"), mustWork = FALSE)
  }
  assign("log_file", tempfile(fileext = ".log"), envir = .GlobalEnv)
  source(file.path(r_dir, "utils-operators.R"))
  source(file.path(r_dir, "update_logs.R"))
  source(file.path(r_dir, "config.R"))
  source(file.path(r_dir, "migrate.R"))
  source(file.path(r_dir, "database.R"))
}

write_dump <- function(pqt_folder, tbl, stamp, select_sql) {
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  path <- file.path(pqt_folder, paste0(tbl, "_", stamp, ".parquet"))
  DBI::dbExecute(con, sprintf(
    "COPY (%s) TO '%s' (FORMAT PARQUET)", select_sql, gsub("\\\\", "/", path)
  ))
  path
}

read_diff <- function(pqt_diff_folder, tbl, base = "b", update = "u") {
  f <- file.path(pqt_diff_folder,
                 sprintf("%s_diff_%s_%s.parquet", tbl, base, update))
  expect_true(file.exists(f))
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbGetQuery(con, sprintf(
    "SELECT * FROM read_parquet('%s')", gsub("\\\\", "/", f)
  ))
}

diff_dirs <- function() {
  pqt <- tempfile("pqt"); dir.create(pqt)
  dif <- tempfile("dif"); dir.create(dif)
  list(pqt = pqt, dif = dif)
}

test_that("a value change on a surviving key ships as an UPDATE row (handle_stats)", {
  d <- diff_dirs()
  write_dump(d$pqt, "handle_stats", "b",
    "SELECT * FROM (VALUES ('h1', 10), ('h2', 5)) t(handle, total_citations)")
  write_dump(d$pqt, "handle_stats", "u",
    "SELECT * FROM (VALUES ('h1', 10), ('h2', 7), ('h3', 1)) t(handle, total_citations)")

  compute_parquet_diffs("b", "u", pqt_folder = d$pqt, pqt_diff_folder = d$dif,
                        tables = "handle_stats")

  diff <- read_diff(d$dif, "handle_stats")
  expect_setequal(paste(diff$handle, diff$operation), c("h3 NEW", "h2 UPDATE"))
  expect_equal(diff$total_citations[diff$operation == "UPDATE"], 7)
})

test_that("a keys-only edge table (cit_all shape) never emits UPDATE rows", {
  d <- diff_dirs()
  write_dump(d$pqt, "cit_all", "b",
    "SELECT * FROM (VALUES ('a', 'b'), ('a', 'c')) t(citing, cited)")
  write_dump(d$pqt, "cit_all", "u",
    "SELECT * FROM (VALUES ('a', 'b'), ('a', 'd')) t(citing, cited)")

  compute_parquet_diffs("b", "u", pqt_folder = d$pqt, pqt_diff_folder = d$dif,
                        tables = "cit_all")

  diff <- read_diff(d$dif, "cit_all")
  expect_equal(nrow(diff), 2)
  expect_setequal(paste(diff$cited, diff$operation), c("d NEW", "c DELETE"))
  expect_false("UPDATE" %in% diff$operation)
})

test_that("articles embeddings-only changes do NOT produce UPDATE rows", {
  d <- diff_dirs()
  write_dump(d$pqt, "articles", "b", "
    SELECT * FROM (VALUES
      ('RePEc:x:1', 'Title One', [1.0, 2.0]),
      ('RePEc:x:2', 'Title Two', [3.0, 4.0])
    ) t(Handle, title, embeddings)")
  write_dump(d$pqt, "articles", "u", "
    SELECT * FROM (VALUES
      ('RePEc:x:1', 'Title One', [9.0, 9.0]),
      ('RePEc:x:2', 'Title Two Revised', [3.0, 4.0])
    ) t(Handle, title, embeddings)")

  compute_parquet_diffs("b", "u", pqt_folder = d$pqt, pqt_diff_folder = d$dif,
                        tables = "articles")

  # x:1 changed only its embeddings (excluded from compare) -> no diff row;
  # x:2 changed a payload column -> exactly one UPDATE row.
  diff <- read_diff(d$dif, "articles")
  expect_equal(nrow(diff), 1)
  expect_equal(diff$Handle, "RePEc:x:2")
  expect_equal(diff$operation, "UPDATE")
  expect_equal(diff$title, "Title Two Revised")
})

test_that("journal_quality fetched_at-only changes do NOT produce UPDATE rows", {
  d <- diff_dirs()
  write_dump(d$pqt, "journal_quality", "b", "
    SELECT * FROM (VALUES
      ('RePEc:aaa:s1', 1.5, TIMESTAMP '2026-01-01 00:00:00'),
      ('RePEc:aaa:s2', 2.0, TIMESTAMP '2026-01-01 00:00:00')
    ) t(series_handle, simple_if, fetched_at)")
  write_dump(d$pqt, "journal_quality", "u", "
    SELECT * FROM (VALUES
      ('RePEc:aaa:s1', 1.5, TIMESTAMP '2026-02-01 00:00:00'),
      ('RePEc:aaa:s2', 2.5, TIMESTAMP '2026-01-01 00:00:00')
    ) t(series_handle, simple_if, fetched_at)")

  compute_parquet_diffs("b", "u", pqt_folder = d$pqt, pqt_diff_folder = d$dif,
                        tables = "journal_quality")

  # s1 changed only fetched_at (excluded) -> silent; s2 changed a real value.
  diff <- read_diff(d$dif, "journal_quality")
  expect_equal(nrow(diff), 1)
  expect_equal(diff$series_handle, "RePEc:aaa:s2")
  expect_equal(diff$operation, "UPDATE")
  expect_equal(diff$simple_if, 2.5)
})

test_that("composite-key tables with payload get UPDATE rows (person_workplaces)", {
  d <- diff_dirs()
  write_dump(d$pqt, "person_workplaces", "b", "
    SELECT * FROM (VALUES
      ('p1', 1, 'ZEW', 97.0),
      ('p1', 2, 'Uni MA', 3.0)
    ) t(short_id, rank, name, share)")
  write_dump(d$pqt, "person_workplaces", "u", "
    SELECT * FROM (VALUES
      ('p1', 1, 'ZEW', 50.0),
      ('p1', 2, 'Uni MA', 3.0)
    ) t(short_id, rank, name, share)")

  compute_parquet_diffs("b", "u", pqt_folder = d$pqt, pqt_diff_folder = d$dif,
                        tables = "person_workplaces")

  diff <- read_diff(d$dif, "person_workplaces")
  expect_equal(nrow(diff), 1)
  expect_equal(diff$operation, "UPDATE")
  expect_equal(diff$rank, 1)
  expect_equal(diff$share, 50)
})

# --- apply_parquet_diffs: UPDATE via delete+insert on a non-articles table ---

skip_if_no_vss <- function() {
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  ok <- tryCatch({
    DBI::dbExecute(con, "LOAD vss;")
    TRUE
  }, error = function(e) FALSE)
  if (!ok) testthat::skip("duckdb vss extension not installed locally")
}

test_that("apply_parquet_diffs applies an UPDATE row via delete+insert (persons)", {
  skip_if_no_vss()

  db_path <- tempfile(fileext = ".duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  # articles must exist for the migrate_schema call inside apply_parquet_diffs.
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, title VARCHAR)")
  DBI::dbExecute(con, "CREATE TABLE persons (short_id VARCHAR, name_full VARCHAR)")
  DBI::dbExecute(con, "
    INSERT INTO persons VALUES ('p1', 'Old Name'), ('p2', 'Untouched')
  ")
  DBI::dbDisconnect(con, shutdown = TRUE)

  dif <- tempfile("dif"); dir.create(dif)
  wcon <- DBI::dbConnect(duckdb::duckdb())
  diff_path <- file.path(dif, "persons_diff_b_u.parquet")
  DBI::dbExecute(wcon, sprintf("
    COPY (
      SELECT 'p1' AS short_id, 'New Name' AS name_full, 'UPDATE' AS operation
    ) TO '%s' (FORMAT PARQUET)
  ", gsub("\\\\", "/", diff_path)))
  DBI::dbDisconnect(wcon, shutdown = TRUE)

  res <- apply_parquet_diffs("b", "u", db_path = db_path, pqt_diff_folder = dif,
                             tables = "persons", rebuild_indices = FALSE)
  expect_equal(res$persons$operation, "UPDATE")
  expect_equal(res$persons$count, 1)

  check <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(check, shutdown = TRUE), add = TRUE)
  got <- DBI::dbGetQuery(check, "SELECT * FROM persons ORDER BY short_id")
  expect_equal(nrow(got), 2)
  expect_equal(got$name_full, c("New Name", "Untouched"))
})
