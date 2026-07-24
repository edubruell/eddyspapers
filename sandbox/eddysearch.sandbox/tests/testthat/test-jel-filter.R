jel_test_con <- function() {
  con <- DBI::dbConnect(duckdb::duckdb(), ":memory:")
  DBI::dbExecute(con, "CREATE TABLE article_jel (handle VARCHAR, jel_code VARCHAR)")
  DBI::dbExecute(con, "
    INSERT INTO article_jel VALUES
      ('repec:aea:x:1', 'J31'),
      ('repec:aea:x:1', 'C21'),
      ('repec:nbr:y:2', 'J38'),
      ('repec:zbw:z:3', 'E24')
  ")
  con
}

jel_candidates <- tibble::tibble(
  Handle = c("RePEc:aea:x:1", "RePEc:nbr:y:2", "RePEc:zbw:z:3", "RePEc:none:n:4"),
  title  = paste("Paper", 1:4)
)

test_that("exact code keeps only papers carrying it", {
  con <- jel_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- filter_by_jel(con, jel_candidates, "J31")
  expect_equal(out$Handle, "RePEc:aea:x:1")
})

test_that("prefix matches all codes under it", {
  con <- jel_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- filter_by_jel(con, jel_candidates, "J3")
  expect_setequal(out$Handle, c("RePEc:aea:x:1", "RePEc:nbr:y:2"))
})

test_that("multiple codes OR together and input is case/whitespace tolerant", {
  con <- jel_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- filter_by_jel(con, jel_candidates, c(" j31 ", "e2"))
  expect_setequal(out$Handle, c("RePEc:aea:x:1", "RePEc:zbw:z:3"))
})

test_that("papers without any JEL rows are dropped (unknown != match)", {
  con <- jel_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- filter_by_jel(con, jel_candidates, "J")
  expect_false("RePEc:none:n:4" %in% out$Handle)
})

test_that("all-invalid codes error loudly; empty candidates return zero rows", {
  con <- jel_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  expect_error(
    filter_by_jel(con, jel_candidates, "J31%; DROP TABLE articles"),
    "no valid JEL codes"
  )
  out <- filter_by_jel(con, jel_candidates[0, ], "J31")
  expect_equal(nrow(out), 0)
  expect_named(out, names(jel_candidates))
})
