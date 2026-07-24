test_that("openalex_pick_best enforces sim, type, and doi guards", {
  mk <- function(...) tibble::tibble(...)
  base <- mk(doi = "10.1016/j.a", sim = 0.9, oa_type = "article")

  expect_equal(openalex_pick_best(base, 0.5)$doi, "10.1016/j.a")
  # review is allowed
  expect_equal(nrow(openalex_pick_best(dplyr::mutate(base, oa_type = "review"), 0.5)), 1)
  # preprint rejected (would be the wrong version's DOI)
  expect_null(openalex_pick_best(dplyr::mutate(base, oa_type = "preprint"), 0.5))
  # sim below floor rejected
  expect_null(openalex_pick_best(base, 0.95))
  # NA doi rejected
  expect_null(openalex_pick_best(dplyr::mutate(base, doi = NA_character_), 0.5))
  # empty rejected
  expect_null(openalex_pick_best(base[0, ], 0.5))
})

test_that("openalex_pick_best picks the highest-sim published result", {
  cand <- tibble::tibble(
    doi     = c("10.1016/low", "10.1016/high", "10.2139/preprint"),
    sim     = c(0.6, 0.85, 0.99),
    oa_type = c("article", "article", "preprint")
  )
  # highest sim among article/review; the higher-sim preprint is excluded
  expect_equal(openalex_pick_best(cand, 0.5)$doi, "10.1016/high")
})

test_that("score_openalex_results normalizes DOIs and scores titles", {
  res <- list(
    list(doi = "https://doi.org/10.1016/J.ENECO.2019.05.009",
         title = "Network tariff design with prosumers", type = "article"),
    list(doi = NULL, title = "No DOI here", type = "article")
  )
  sc <- score_openalex_results(res, "Network tariff design with prosumers")
  expect_equal(sc$doi[1], "10.1016/j.eneco.2019.05.009")   # lowercased, resolver stripped
  expect_equal(sc$sim[1], 1)
  expect_true(is.na(sc$doi[2]))
})

test_that("openalex_match_from_resp tolerates NULL/error responses", {
  expect_null(openalex_match_from_resp(NULL, "t", 0.5))
  expect_null(openalex_match_from_resp(simpleError("boom"), "t", 0.5))
})

test_that("openalex_lookup_dois returns a typed empty frame for empty input", {
  out <- openalex_lookup_dois(character(0), "x@y.z")
  expect_equal(nrow(out), 0)
  expect_named(out, c("doi", "oa_title", "oa_type"))
})

test_that("finalize includes the openalex ledger as a fuzzy fill-only source", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR, url VARCHAR)")
  # w1 doi-less -> openalex fills it; w2 already has a DOI -> openalex must NOT overwrite
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('RePEc:w:1', NULL,            'http://www.sciencedirect.com/x/1'),
    ('RePEc:w:2', '10.1016/real2', 'http://www.sciencedirect.com/x/2')")
  DBI::dbDisconnect(con, shutdown = TRUE)

  rds_dir <- file.path(dir, "rds"); dir.create(rds_dir)
  write_parquet_df(tibble::tibble(
    Handle = c("RePEc:w:1", "RePEc:w:2"),
    doi = c("10.1016/found1", "10.9999/wrong2"),
    sim = 0.9, oa_type = "article", attempted_at = Sys.time()),
    file.path(dir, "openalex_attempts.parquet"))

  manifest <- finalize_doi_patch(db_path = db_path, rds_folder = rds_dir, pqt_patch_folder = dir)
  patch <- read_parquet_df(sub("\\.manifest\\.json$", ".parquet", manifest))

  expect_setequal(patch$Handle, "RePEc:w:1")
  expect_equal(patch$doi[patch$Handle == "RePEc:w:1"], "10.1016/found1")
  expect_equal(patch$doi_source[patch$Handle == "RePEc:w:1"], "openalex")
})
