make_df <- function(n = 3) {
  data.frame(
    Handle   = paste0("repec:test:paper:", seq_len(n)),
    title    = paste0("Title ", seq_len(n)),
    year     = 2020L,
    authors  = "Smith, J",
    journal  = "Test Journal",
    category = "econ",
    stringsAsFactors = FALSE
  )
}

test_that("fmt_row formats a single row with correct structure", {
  df  <- make_df(3)
  out <- fmt_row(df, 2)
  expect_true(grepl("\\[2\\]", out))
  expect_true(grepl("Title 2", out))
  expect_true(grepl("2020", out))
  expect_true(grepl("Smith, J", out))
  expect_true(grepl("Test Journal", out))
  expect_true(grepl("econ", out))
  expect_true(grepl("repec:test:paper:2", out))
})

test_that("format_results on a 1-row df returns a single entry", {
  df  <- make_df(1)
  out <- format_results(df)
  expect_true(grepl("\\[1\\]", out))
  expect_true(grepl("repec:test:paper:1", out))
  expect_false(grepl("\\[2\\]", out))
})

test_that("format_results where n > nrow returns all rows without error", {
  df  <- make_df(3)
  out <- format_results(df, n = 10)
  expect_true(grepl("\\[1\\]", out))
  expect_true(grepl("\\[2\\]", out))
  expect_true(grepl("\\[3\\]", out))
  expect_false(grepl("\\[4\\]", out))
})

test_that("format_results respects n smaller than nrow", {
  df  <- make_df(5)
  out <- format_results(df, n = 2)
  expect_true(grepl("\\[1\\]", out))
  expect_true(grepl("\\[2\\]", out))
  expect_false(grepl("\\[3\\]", out))
})

test_that("fmt_row handles missing journal column gracefully (NA-like)", {
  df <- data.frame(
    Handle   = "repec:test:1",
    title    = "Test Title",
    year     = 2021L,
    authors  = "Doe, J",
    journal  = NA_character_,
    category = "econ",
    stringsAsFactors = FALSE
  )
  out <- fmt_row(df, 1)
  expect_true(grepl("Test Title", out))
  expect_true(grepl("repec:test:1", out))
})
