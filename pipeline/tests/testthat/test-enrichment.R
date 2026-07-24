# Tests for the M8 Wave 1 enrichment helpers: DOI normalization, EDIRC
# location parsing, seriesfactors parsing, and the migrate/patch machinery
# against a throwaway DuckDB.

if (!exists("normalize_doi", mode = "function")) {
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
  source(file.path(r_dir, "patch.R"))
  source(file.path(r_dir, "enrich_doi.R"))
  source(file.path(r_dir, "edirc.R"))
  source(file.path(r_dir, "journal_quality.R"))
}

# --- normalize_doi -----------------------------------------------------------

test_that("normalize_doi strips resolver prefixes and lowercases", {
  expect_equal(normalize_doi("https://doi.org/10.1257/AER.20180779"), "10.1257/aer.20180779")
  expect_equal(normalize_doi("http://dx.doi.org/10.1016/j.jpubeco.2020.104"), "10.1016/j.jpubeco.2020.104")
  expect_equal(normalize_doi("doi:10.3386/w12345"), "10.3386/w12345")
  expect_equal(normalize_doi("DOI: 10.3386/w12345"), "10.3386/w12345")
})

test_that("normalize_doi trims trailing punctuation but keeps internal", {
  expect_equal(normalize_doi("10.1002/(SICI)1099-1255(199601)11:1<1::AID-JAE364>3.0.CO;2-A."),
               "10.1002/(sici)1099-1255(199601)11:1<1::aid-jae364>3.0.co;2-a")
  expect_equal(normalize_doi("10.1257/aer.100.1.1,"), "10.1257/aer.100.1.1")
})

test_that("normalize_doi rejects non-DOIs as NA", {
  expect_true(is.na(normalize_doi("not-a-doi")))
  expect_true(is.na(normalize_doi("")))
  expect_true(is.na(normalize_doi("10.12/tooshortprefix")))
  expect_true(is.na(normalize_doi("hdl:1765/12345")))
})

test_that("normalize_doi is vectorised", {
  out <- normalize_doi(c("10.1257/aer.1", "junk", NA))
  expect_equal(out, c("10.1257/aer.1", NA, NA))
})

# --- edirc_country -----------------------------------------------------------

test_that("edirc_country handles the two documented shapes", {
  expect_equal(edirc_country("Basel, Switzerland"), "Switzerland")
  expect_equal(edirc_country("College Station, TX (United States)"), "United States")
  expect_equal(edirc_country("Frankfurt am Main, Germany"), "Germany")
})

test_that("edirc_country returns empty when the pattern doesn't hold", {
  expect_equal(edirc_country("Mannheim"), "")
  expect_equal(edirc_country(""), "")
  expect_equal(edirc_country(NULL), "")
})

# --- parse_seriesfactors -----------------------------------------------------

test_that("parse_seriesfactors reads the documented 10-field format", {
  header <- c("Impact factors for series listed in RePEc", "----", "")
  rows <- purrr::map_chr(seq_len(1200), ~paste(
    sprintf("RePEc:aaa:ser%04d", .x), "100", "1.5", "0.02", "0.4", "0.01",
    "12", "55.5", "ReDIF-article", "Some Journal, Some Publisher",
    sep = "\t"
  ))
  f <- tempfile(fileext = ".txt")
  readr::write_lines(c(header, rows), f)

  out <- parse_seriesfactors(f)
  expect_equal(nrow(out), 1200)
  # series_handle is lowercased on parse to match journals.series_handle.
  expect_equal(out$series_handle[1], "repec:aaa:ser0001")
  expect_equal(out$simple_if[1], 1.5)
  expect_equal(out$h_index[1], 12L)
  expect_equal(out$series_type[1], "ReDIF-article")
})

test_that("parse_seriesfactors hard-fails on field-count drift", {
  rows <- purrr::map_chr(seq_len(1200), ~paste(
    sprintf("RePEc:aaa:ser%04d", .x), "100", "1.5",
    sep = "\t"
  ))
  f <- tempfile(fileext = ".txt")
  readr::write_lines(rows, f)
  expect_error(parse_seriesfactors(f), "format changed")
})

test_that("parse_seriesfactors hard-fails on suspiciously few rows", {
  f <- tempfile(fileext = ".txt")
  readr::write_lines("RePEc:aaa:x\t1\t1\t1\t1\t1\t1\t1\tReDIF-article\tX", f)
  expect_error(parse_seriesfactors(f), "only")
})

# --- migrate_schema + patches on a throwaway DB ------------------------------

fresh_db <- function() {
  con <- DBI::dbConnect(duckdb::duckdb())
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, title VARCHAR, year INTEGER)")
  DBI::dbExecute(con, "
    INSERT INTO articles VALUES
      ('RePEc:aea:x:1', 'Paper A', 2020),
      ('RePEc:nbr:y:2', 'Paper B', 2021)
  ")
  con
}

test_that("migrate_schema is idempotent and records itself", {
  con <- fresh_db()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))

  first <- migrate_schema(con)
  expect_true("m8_wave1" %in% first)
  expect_true("doi" %in% DBI::dbGetQuery(con, "DESCRIBE articles")$column_name)
  expect_true(all(c("article_jel", "jel_codes", "institutions",
                    "person_workplaces", "journal_quality") %in% DBI::dbListTables(con)))
  expect_length(migrate_schema(con), 0)
})

test_that("update_columns patch touches only matching rows and is idempotent", {
  con <- fresh_db()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  migrate_schema(con)

  pdir <- tempfile("patches")
  dir.create(pdir)
  df <- tibble::tibble(Handle = "RePEc:aea:x:1", doi = "10.1257/t", doi_source = "redif")
  manifest <- write_patch(df, "articles", key_cols = "Handle",
                          mode = "update_columns", patch_id = "p1",
                          pqt_patch_folder = pdir)

  expect_true(apply_patch(con, manifest))
  got <- DBI::dbGetQuery(con, "SELECT Handle, doi FROM articles ORDER BY Handle")
  expect_equal(got$doi, c("10.1257/t", NA))
  expect_false(apply_patch(con, manifest))
})

test_that("a failing patch rolls back and unknown columns are rejected", {
  con <- fresh_db()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  migrate_schema(con)

  pdir <- tempfile("patches")
  dir.create(pdir)
  bad <- tibble::tibble(Handle = "RePEc:aea:x:1", nope = "x")
  manifest <- write_patch(bad, "articles", key_cols = "Handle",
                          mode = "update_columns", patch_id = "pbad",
                          pqt_patch_folder = pdir)
  expect_error(apply_patch(con, manifest))
  expect_true(is.na(DBI::dbGetQuery(
    con, "SELECT doi FROM articles WHERE Handle = 'RePEc:aea:x:1'"
  )$doi))
})

test_that("write_patch rejects duplicate keys and missing key columns", {
  pdir <- tempfile("patches")
  dir.create(pdir)
  dup <- tibble::tibble(Handle = c("a", "a"), doi = c("x", "y"))
  expect_error(
    write_patch(dup, "articles", key_cols = "Handle",
                mode = "update_columns", pqt_patch_folder = pdir),
    "not unique"
  )
  expect_error(
    write_patch(tibble::tibble(doi = "x"), "articles", key_cols = "Handle",
                mode = "update_columns", pqt_patch_folder = pdir),
    "missing"
  )
})

test_that("replace_table patch replaces content and restores indices", {
  con <- fresh_db()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  migrate_schema(con)
  DBI::dbExecute(con, "INSERT INTO article_jel VALUES ('old', 'A10')")

  pdir <- tempfile("patches")
  dir.create(pdir)
  df <- tibble::tibble(handle = c("repec:aea:x:1"), jel_code = c("J31"))
  manifest <- write_patch(df, "article_jel", mode = "replace_table",
                          patch_id = "pjel", pqt_patch_folder = pdir)
  apply_patch(con, manifest)

  got <- DBI::dbGetQuery(con, "SELECT * FROM article_jel")
  expect_equal(nrow(got), 1)
  expect_equal(got$jel_code, "J31")
})
