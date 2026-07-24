# Tests for the Crossref matching guards in crossref_match_one and its
# first_author_token helper. Network-free: httr2::req_perform / resp_status /
# resp_body_json are mocked (same local_mocked_bindings pattern as the tidyllm
# mocks in test-embedding.R); the request builders run for real but nothing is
# performed. Guard contract (see enrich_doi.R): score >= threshold (default
# 85), |year diff| <= 1, Crossref type agrees with is_series, first-author
# lastname among Crossref authors.

if (!exists("crossref_match_one", mode = "function")) {
  r_dir <- normalizePath(file.path(testthat::test_path(), "..", "..", "R"),
                         mustWork = FALSE)
  if (!dir.exists(r_dir)) {
    r_dir <- normalizePath(file.path("pipeline", "R"), mustWork = FALSE)
  }
  assign("log_file", tempfile(fileext = ".log"), envir = .GlobalEnv)
  # This file runs first alphabetically and source() lands in the global env,
  # so later files' exists()-guards see whatever is defined here. Source the
  # same set as test-enrichment.R to keep its guard (on normalize_doi,
  # defined in enrich_doi.R) sound when the whole dir runs.
  source(file.path(r_dir, "utils-operators.R"))
  source(file.path(r_dir, "update_logs.R"))
  source(file.path(r_dir, "config.R"))
  source(file.path(r_dir, "migrate.R"))
  source(file.path(r_dir, "patch.R"))
  source(file.path(r_dir, "enrich_doi.R"))
  source(file.path(r_dir, "edirc.R"))
  source(file.path(r_dir, "journal_quality.R"))
}

# --- first_author_token ------------------------------------------------------

test_that("first_author_token is the lowercased last token of the first author", {
  expect_equal(first_author_token("Arindrajit Dube; T. William Lester; Michael Reich"),
               "dube")
  expect_equal(first_author_token("David Card"), "card")
  expect_equal(first_author_token("Jan C. van Ours; Someone Else"), "ours")
})

test_that("first_author_token degrades to empty on NULL/empty input", {
  expect_equal(first_author_token(NULL), "")
  expect_equal(first_author_token(""), "")
})

# --- crossref_match_one guards (mocked httr2) --------------------------------

cr_item <- function(doi = "10.1257/AER.TEST",
                    title = "A Matching Title",
                    year = 2020,
                    type = "journal-article",
                    family = "dube",
                    score = 99) {
  list(
    DOI = doi,
    title = list(title),
    issued = list(`date-parts` = list(list(year))),
    type = type,
    author = list(list(family = family)),
    score = score
  )
}

mock_crossref <- function(items, status = 200L, env = parent.frame()) {
  testthat::local_mocked_bindings(
    req_perform    = function(req, ...) structure(list(), class = "httr2_response"),
    resp_status    = function(resp) status,
    resp_body_json = function(resp, ...) list(message = list(items = items)),
    .package = "httr2",
    .env = env
  )
}

match_one <- function(...) {
  defaults <- list(
    title = "Some Title", authors = "Arindrajit Dube; Michael Reich",
    year = 2020, is_series = FALSE, mailto = "test@example.org"
  )
  args <- utils::modifyList(defaults, list(...))
  crossref_match_one(args$title, args$authors, args$year, args$is_series, args$mailto)
}

test_that("a candidate passing all guards returns a normalized-DOI row", {
  mock_crossref(list(cr_item()))
  out <- match_one()
  expect_equal(nrow(out), 1)
  expect_equal(out$doi, "10.1257/aer.test")
  expect_equal(out$cr_type, "journal-article")
  expect_equal(out$cr_year, 2020L)
  expect_equal(out$score, 99)
})

test_that("score guard: below the default 85 threshold rejects, at 85 passes", {
  mock_crossref(list(cr_item(score = 84.9)))
  expect_null(match_one())

  mock_crossref(list(cr_item(score = 85)))
  expect_equal(nrow(match_one()), 1)
})

test_that("year guard: off by one passes, off by two rejects", {
  mock_crossref(list(cr_item(year = 2021)))
  expect_equal(nrow(match_one(year = 2020)), 1)

  mock_crossref(list(cr_item(year = 2022)))
  expect_null(match_one(year = 2020))
})

test_that("type guard is mandatory in both directions", {
  # A journal-article candidate must not match a working-paper row (the live
  # probe showed WP DOIs outranking the published article's own DOI).
  mock_crossref(list(cr_item(type = "journal-article")))
  expect_null(match_one(is_series = TRUE))

  mock_crossref(list(cr_item(type = "report")))
  expect_null(match_one(is_series = FALSE))
  expect_equal(nrow(match_one(is_series = TRUE)), 1)
})

test_that("author guard: first-author lastname must appear among Crossref authors", {
  mock_crossref(list(cr_item(family = "smith")))
  expect_null(match_one(authors = "Arindrajit Dube; Michael Reich"))
})

test_that("the first surviving candidate wins over later ones", {
  mock_crossref(list(
    cr_item(doi = "10.1257/rejected", score = 10),
    cr_item(doi = "10.1257/accepted")
  ))
  out <- match_one()
  expect_equal(out$doi, "10.1257/accepted")
})

test_that("a surviving candidate with an invalid DOI yields no usable row", {
  mock_crossref(list(cr_item(doi = "not-a-doi")))
  out <- match_one()
  expect_true(is.null(out) || nrow(out) == 0)
})

test_that("empty item lists, non-200 responses, and transport errors give NULL", {
  mock_crossref(list())
  expect_null(match_one())

  mock_crossref(list(cr_item()), status = 500L)
  expect_null(match_one())

  testthat::local_mocked_bindings(
    req_perform = function(req, ...) stop("simulated connection failure"),
    .package = "httr2"
  )
  expect_null(match_one())
})
