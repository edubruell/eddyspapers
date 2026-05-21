setup_test_con <- function() {
  con <- DBI::dbConnect(duckdb::duckdb(), ":memory:")
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, title VARCHAR)")
  DBI::dbExecute(con, "CREATE TABLE journals (id VARCHAR)")
  con
}

test_that("inject_limit appends LIMIT 5000 when none present", {
  sql <- "SELECT * FROM articles"
  result <- inject_limit(sql)
  expect_true(grepl("LIMIT 5000", result))
})

test_that("inject_limit leaves SQL unchanged when LIMIT already present", {
  sql <- "SELECT * FROM articles LIMIT 10"
  result <- inject_limit(sql)
  expect_equal(result, sql)
})

test_that("inject_limit treats lowercase limit as having a limit", {
  sql <- "SELECT * FROM articles limit 10"
  result <- inject_limit(sql)
  expect_equal(result, sql)
})

test_that("valid SELECT passes validation", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql("SELECT * FROM articles", con))
})

test_that("UNION of two SELECTs passes validation", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql("SELECT Handle FROM articles UNION SELECT Handle FROM articles", con))
})

test_that("INSERT statement is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(validate_sql("INSERT INTO articles VALUES ('x', 'y')", con), "Only SELECT queries are allowed.")
})

test_that("DROP statement is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(validate_sql("DROP TABLE articles", con), "Only SELECT queries are allowed.")
})

test_that("SELECT with read_csv function is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(validate_sql("SELECT * FROM read_csv('/etc/passwd')", con), "Blocked function: read_csv")
})

test_that("SELECT from information_schema.tables is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(validate_sql("SELECT * FROM information_schema.tables", con), "Table not in allowlist")
})

test_that("SELECT from articles passes", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql("SELECT Handle, title FROM articles", con))
})

test_that("SELECT with subquery from articles passes", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql("SELECT Handle FROM (SELECT Handle FROM articles) sub", con))
})

test_that("UNION ALL of two allowlisted tables passes (SET_OPERATION_NODE)", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql(
    "SELECT Handle FROM articles UNION ALL SELECT Handle FROM articles", con
  ))
})

test_that("subquery referencing a non-allowlisted table is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("SELECT Handle FROM articles WHERE Handle IN (SELECT handle FROM secret_table)", con),
    "Table not in allowlist"
  )
})

test_that("CTE referencing a non-allowlisted table inside the CTE body is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("WITH x AS (SELECT Handle FROM secret_table) SELECT * FROM x", con),
    "Table not in allowlist"
  )
})

test_that("read_csv inside a subquery is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("SELECT * FROM (SELECT * FROM read_csv('/etc/passwd')) sub", con),
    "Blocked function: read_csv"
  )
})

test_that("syntactically invalid SQL is rejected with SELECT error", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("SELECT * FROM WHERE", con),
    "Only SELECT queries are allowed."
  )
})

test_that("JOIN with both tables in allowlist passes", {
  con <- setup_test_con()
  DBI::dbExecute(con, "CREATE TABLE cit_internal (citing VARCHAR, cited VARCHAR)")
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_invisible(validate_sql(
    "SELECT a.Handle FROM articles a JOIN cit_internal ci ON a.Handle = ci.citing", con
  ))
})

test_that("JOIN with one non-allowlisted table is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("SELECT a.Handle FROM articles a JOIN secret_table s ON a.Handle = s.handle", con),
    "Table not in allowlist"
  )
})

test_that("schema-qualified table like main.articles is rejected", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    validate_sql("SELECT * FROM main.articles", con),
    "Table not in allowlist"
  )
})

test_that("inject_limit with con: outer query without LIMIT gets LIMIT 5000 even when subquery has LIMIT", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  sql    <- "SELECT * FROM (SELECT Handle FROM articles LIMIT 10) sub"
  result <- inject_limit(sql, con = con)
  expect_true(grepl("LIMIT 5000", result))
})

test_that("inject_limit with con: LIMIT in a LIKE string does not prevent outer LIMIT being added", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  sql    <- "SELECT * FROM articles WHERE title LIKE '%no limit%'"
  result <- inject_limit(sql, con = con)
  expect_true(grepl("LIMIT 5000", result))
})

test_that("inject_limit with con: query with real outer LIMIT is left unchanged", {
  con <- setup_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  sql    <- "SELECT * FROM articles LIMIT 25"
  result <- inject_limit(sql, con = con)
  expect_equal(result, sql)
})
