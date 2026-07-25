# Phase B (08_title_match.md) — widened journal selector + the hardened
# source-blocked works pull's projection SQL.

test_that("doi_less_journals excludes series + DOI'd rows, respects min_papers", {
  dir <- withr::local_tempdir()
  db  <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db)
  DBI::dbExecute(con, "CREATE TABLE articles
    (Handle VARCHAR, title VARCHAR, year INTEGER, journal VARCHAR, doi VARCHAR, is_series BOOLEAN)")
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('a','t',2010,'Big J',NULL,FALSE),('b','t',2010,'Big J',NULL,FALSE),('c','t',2010,'Big J',NULL,FALSE),
    ('d','t',2010,'Small J',NULL,FALSE),
    ('e','t',2010,'Big J','10.1/x',FALSE),
    ('i',NULL,2010,'Big J',NULL,FALSE),
    ('j','t',NULL,'Big J',NULL,FALSE),
    ('f','t',2010,'WP Series',NULL,TRUE),('g','t',2010,'WP Series',NULL,TRUE),('h','t',2010,'WP Series',NULL,TRUE)")
  DBI::dbDisconnect(con, shutdown = TRUE)

  js <- doi_less_journals(db, min_papers = 2L)
  # Small J below threshold; WP Series is is_series; the DOI'd, NULL-title and
  # NULL-year Big J rows all not counted.
  expect_equal(js$journal, "Big J")
  expect_equal(js$n, 3L)
})

test_that("oa_pull_chunks runs a chunk through the worker, then skips it on resume", {
  dir <- withr::local_tempdir()
  out_dir <- file.path(dir, "out")
  # sql_of ignores globs and writes a tiny LOCAL parquet to the tmp path (no S3);
  # the worker renames tmp -> out, which is the completion signal oa_pull_chunks polls.
  sql_of <- function(globs, tmp) sprintf(
    "COPY (SELECT * FROM (VALUES ('x', 1)) AS t(a, b)) TO '%s' (FORMAT parquet)", tmp)
  chunks <- list(list(name = "c1", globs = "unused"))

  oa_pull_chunks(chunks, out_dir, sql_of, deadline_s = 120, retries = 2L, threads = 1L)
  outfile <- file.path(out_dir, "c1.parquet")
  expect_true(file.exists(outfile))
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_equal(DBI::dbGetQuery(con, sprintf("SELECT count(*) n FROM read_parquet('%s')", outfile))$n, 1)

  # resume: a pre-existing chunk output is skipped, not re-run (mtime unchanged).
  mt <- file.mtime(outfile); Sys.sleep(1.1)
  oa_pull_chunks(chunks, out_dir, sql_of, deadline_s = 120, retries = 2L, threads = 1L)
  expect_equal(file.mtime(outfile), mt)
})

# A works parquet shaped like the OpenAlex snapshot: nested primary_location
# struct so the projection's `primary_location.source.id` leaf is exercised.
make_works_snapshot_parquet <- function(path) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, "CREATE TABLE w AS SELECT * FROM (VALUES
    ('W1','https://doi.org/10.1016/A','Alpha title',2020,'article',      {'source': {'id':'S1'}}),
    ('W2', NULL,                      'No doi title',2020,'article',      {'source': {'id':'S1'}}),
    ('W3','https://doi.org/10.1016/b','Gamma review',2021,'review',       {'source': {'id':'S2'}}),
    ('W4','https://doi.org/10.1016/c','Wrong source',2020,'article',      {'source': {'id':'S9'}}),
    ('W5','https://doi.org/10.1016/d','Book chapter', 2020,'book-chapter',{'source': {'id':'S1'}}),
    ('W6','https://doi.org/10.1016/e', NULL,          2020,'article',      {'source': {'id':'S1'}})
  ) AS t(id, doi, title, publication_year, type, primary_location)")
  DBI::dbExecute(con, sprintf("COPY w TO '%s' (FORMAT parquet)", path))
}

test_that("oa_source_works_copy_sql projects matcher columns, filters by source/type/doi, normalizes DOI", {
  dir <- withr::local_tempdir()
  wp  <- file.path(dir, "works.parquet"); make_works_snapshot_parquet(wp)
  out <- file.path(dir, "out.parquet")
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))

  DBI::dbExecute(con, oa_source_works_copy_sql(wp, out, c("S1", "S2")))
  res <- DBI::dbGetQuery(con, sprintf("SELECT * FROM read_parquet('%s') ORDER BY openalex_id", out))

  expect_named(res, c("openalex_id", "doi", "title", "year", "src_id"))
  # W1 (S1 article) + W3 (S2 review) kept; W4 out of source set, W2 no DOI,
  # W5 not article/review, W6 NULL title — all dropped.
  expect_setequal(res$openalex_id, c("W1", "W3"))
  expect_true(all(grepl("^10\\.", res$doi)))            # resolver-stripped + lowercased
  expect_equal(res$doi[res$openalex_id == "W1"], "10.1016/a")
  expect_equal(res$src_id[res$openalex_id == "W1"], "S1")
  expect_equal(res$year[res$openalex_id == "W3"], 2021L)
})
