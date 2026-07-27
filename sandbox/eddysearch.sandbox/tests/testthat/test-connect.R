# The DB lockdown (connect.R) is the sandbox's OS/filesystem/network isolation. These tests
# guard the two things that silently broke before: the pragma ORDER (enable_external_access
# must precede disabled_filesystems, or it errors) and that the lockdown actually blocks
# external access. apply_lockdown fails closed, so "applies without error" == "fully applied".

make_ro_con <- function() {
  f <- tempfile(fileext = ".duckdb")
  w <- DBI::dbConnect(duckdb::duckdb(), f)
  DBI::dbExecute(w, "CREATE TABLE articles(Handle VARCHAR)")
  DBI::dbDisconnect(w, shutdown = TRUE)
  DBI::dbConnect(duckdb::duckdb(), dbdir = f, read_only = TRUE)
}

test_that("all lockdown pragmas apply without error (fail-closed happy path)", {
  con <- make_ro_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_no_error(apply_lockdown(con))
})

test_that("enable_external_access precedes disabled_filesystems in the pragma order", {
  pragmas <- lockdown_pragmas()
  i_ext <- which(grepl("enable_external_access", pragmas))
  i_dfs <- which(grepl("disabled_filesystems", pragmas))
  expect_true(i_ext < i_dfs)
  expect_equal(pragmas[[length(pragmas)]], "SET lock_configuration = true")
})

test_that("lockdown blocks filesystem reads and ATTACH but allows normal queries", {
  con <- make_ro_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  apply_lockdown(con)
  tmp_csv <- tempfile(fileext = ".csv")
  writeLines("a,b\n1,2", tmp_csv)
  expect_error(DBI::dbGetQuery(con, sprintf("SELECT * FROM read_csv_auto('%s')", tmp_csv)))
  expect_error(DBI::dbExecute(con, "ATTACH 'other.db' AS o"))
  expect_equal(DBI::dbGetQuery(con, "SELECT count(*) AS c FROM articles")$c, 0)
})
