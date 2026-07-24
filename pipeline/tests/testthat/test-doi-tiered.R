test_that("title_sim is 1 for identical, 0 for disjoint, in-between otherwise", {
  expect_equal(title_sim("Minimum wage effects", "minimum   WAGE effects!"), 1)
  expect_equal(title_sim("Minimum wage effects", "Quantum gravity loops"), 0)
  s <- title_sim("The effect of X on Y", "Effect of X on Y")
  expect_true(s > 0 && s < 1)
  expect_equal(title_sim("", "anything"), 0)
  expect_equal(title_sim(NA, "anything"), 0)
})

test_that("title_sim is symmetric and robust to punctuation-only titles", {
  expect_equal(title_sim("Minimum wage effects", "wage effects minimum"),
               title_sim("wage effects minimum", "Minimum wage effects"))
  # punctuation-only / empty normalize to no tokens -> 0, never NaN
  expect_equal(title_sim("!!!", "???"), 0)
  expect_equal(title_sim("-- .. //", "anything at all"), 0)
  expect_false(is.nan(title_sim("", "")))
  expect_equal(title_sim("", ""), 0)
})

test_that("response parsers tolerate NULL and error objects (parallel on_error='continue')", {
  expect_null(parse_crossref_work(NULL))
  expect_null(parse_crossref_work(simpleError("boom")))
  expect_null(parse_crossref_work(structure(class = c("httr2_failure", "error", "condition"), list())))
  expect_null(container_match_from_resp(NULL, "t", 2010, 0.5))
  expect_null(container_match_from_resp(simpleError("boom"), "t", 2010, 0.5))
})

test_that("score_crossref_items scores each item against the query title", {
  items <- list(
    list(DOI = "10.1016/j.a", title = list("Minimum wage effects"), type = "journal-article",
         issued = list(`date-parts` = list(list(2010))), score = 40),
    list(DOI = "10.1016/j.b", title = list("Totally unrelated"), type = "report", score = 99)
  )
  sc <- score_crossref_items(items, "Minimum wage effects")
  expect_equal(nrow(sc), 2)
  expect_equal(sc$doi, c("10.1016/j.a", "10.1016/j.b"))
  expect_equal(sc$sim[1], 1)
  expect_true(sc$sim[2] < 0.2)
  expect_equal(sc$cr_year[1], 2010L)
  expect_true(is.na(sc$cr_year[2]))          # missing issued -> NA year
})

test_that("container_pick_best enforces every guard", {
  mk <- function(...) tibble::tibble(...)
  base <- mk(doi = "10.1/a", sim = 0.9, cr_year = 2010L,
             cr_type = "journal-article", score = 40)

  # happy path: passes all guards
  expect_equal(container_pick_best(base, year = 2010, min_sim = 0.5)$doi, "10.1/a")
  # accepted with a low Crossref score (no score floor by design)
  expect_equal(nrow(container_pick_best(base, year = 2010, min_sim = 0.5)), 1)

  # year out of range (>1) -> reject
  expect_null(container_pick_best(base, year = 2013, min_sim = 0.5))
  # year within 1 -> accept
  expect_equal(nrow(container_pick_best(base, year = 2011, min_sim = 0.5)), 1)
  # type not journal-article -> reject
  expect_null(container_pick_best(dplyr::mutate(base, cr_type = "posted-content"),
                                  year = 2010, min_sim = 0.5))
  # sim below floor -> reject
  expect_null(container_pick_best(base, year = 2010, min_sim = 0.95))
  # NA doi -> reject
  expect_null(container_pick_best(dplyr::mutate(base, doi = NA_character_),
                                  year = 2010, min_sim = 0.5))
  # NA cr_year -> reject
  expect_null(container_pick_best(dplyr::mutate(base, cr_year = NA_integer_),
                                  year = 2010, min_sim = 0.5))
  # empty input -> NULL
  expect_null(container_pick_best(base[0, ], year = 2010, min_sim = 0.5))
})

test_that("container_pick_best picks the highest-sim survivor and one row on ties", {
  cand <- tibble::tibble(
    doi     = c("10.1/low", "10.1/high", "10.1/wrongtype"),
    sim     = c(0.6, 0.9, 0.99),
    cr_year = c(2010L, 2010L, 2010L),
    cr_type = c("journal-article", "journal-article", "report"),
    score   = c(90, 50, 99)
  )
  # highest sim among journal-articles wins; the higher-sim 'report' is excluded
  expect_equal(container_pick_best(cand, year = 2010, min_sim = 0.5)$doi, "10.1/high")

  ties <- tibble::tibble(
    doi = c("10.1/t1", "10.1/t2"), sim = c(0.8, 0.8), cr_year = 2010L,
    cr_type = "journal-article", score = c(10, 99)
  )
  best <- container_pick_best(ties, year = 2010, min_sim = 0.5)
  expect_equal(nrow(best), 1)              # with_ties = FALSE => exactly one row
})

test_that("read_doi_ledger returns a typed empty frame for each tier schema", {
  nat <- read_doi_ledger(tempfile(fileext = ".parquet"), list(sim = numeric()))
  expect_equal(nrow(nat), 0)
  expect_named(nat, c("Handle", "doi", "sim", "attempted_at"))

  cont <- read_doi_ledger(tempfile(fileext = ".parquet"),
                          list(sim = numeric(), cr_type = character(), score = numeric()))
  expect_equal(nrow(cont), 0)
  expect_named(cont, c("Handle", "doi", "sim", "cr_type", "score", "attempted_at"))
})

test_that("nature_doi_guess transforms only Nature article URLs", {
  expect_equal(nature_doi_guess("https://www.nature.com/articles/s41586-020-2489-0"),
               "10.1038/s41586-020-2489-0")
  expect_equal(nature_doi_guess("https://www.nature.com/articles/507437a?foo=1#x"),
               "10.1038/507437a")
  expect_true(is.na(nature_doi_guess("http://www.sciencedirect.com/science/article/pii/S123")))
  expect_true(is.na(nature_doi_guess("https://www.nature.com/nature/")))
  expect_true(is.na(nature_doi_guess(NA)))
  # vectorized
  out <- nature_doi_guess(c("https://www.nature.com/articles/nature12398", "http://x.org"))
  expect_equal(out, c("10.1038/nature12398", NA))
})

test_that("nature_safe_doi transforms only structurally-safe id shapes", {
  expect_equal(nature_safe_doi("https://www.nature.com/articles/s41586-020-2489-0"),
               "10.1038/s41586-020-2489-0")                       # modern_s
  expect_equal(nature_safe_doi("https://www.nature.com/articles/507437a"),
               "10.1038/507437a")                                 # legacy_num
  expect_equal(nature_safe_doi("https://www.nature.com/articles/nature12398"),
               "10.1038/nature12398")                             # portfolio prefix
  expect_equal(nature_safe_doi("https://www.nature.com/articles/d41586-025-01926-y"),
               "10.1038/d41586-025-01926-y")                      # news
  # ambiguous non-Nature-portfolio code -> NA (don't risk a wrong DOI)
  expect_true(is.na(nature_safe_doi("https://www.nature.com/articles/embr201337945")))
  expect_true(is.na(nature_safe_doi("http://www.sciencedirect.com/x")))
})

test_that("container_host_patterns includes the big publishers, excludes WP hosts", {
  h <- container_host_patterns()
  expect_true(all(c("sciencedirect.com", "cambridge.org", "wiley.com") %in% h))
  expect_false(any(c("mpra.ub", "arxiv.org", "nber.org", "iza.org") %in% h))
})

test_that("ledger_doi_hits normalizes, drops NA/dupes, tags provenance", {
  tmp <- withr::local_tempfile(fileext = ".parquet")
  write_parquet_df(tibble::tibble(
    Handle = c("RePEc:a:1", "RePEc:a:1", "RePEc:b:2", "RePEc:c:3"),
    doi    = c("https://doi.org/10.1038/ABC", "10.1038/abc", NA, "not-a-doi"),
    sim    = c(0.9, 0.9, NA, 0.8),
    attempted_at = Sys.time()
  ), tmp)
  out <- ledger_doi_hits(tmp, "nature_transform")
  expect_equal(nrow(out), 1)                       # b2 NA + c3 invalid dropped, a1 deduped
  expect_equal(out$doi, "10.1038/abc")             # normalized lowercase, resolver stripped
  expect_equal(out$doi_source, "nature_transform")
  expect_named(out, c("Handle", "doi", "doi_source"))
})

test_that("ledger_doi_hits returns an empty typed frame for a missing ledger", {
  out <- ledger_doi_hits(tempfile(fileext = ".parquet"), "crossref")
  expect_equal(nrow(out), 0)
  expect_named(out, c("Handle", "doi", "doi_source"))
})

test_that("finalize_doi_patch dedups by Handle with provenance priority and skips no-ops", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  # corpus: a1 already has the url DOI; a2 doi-less; a3 doi-less; a4 not in any source
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR, url VARCHAR)")
  # x1 doi-less, DOI embedded in url -> url source provides it
  # x2 doi-less nature url, claimed by BOTH ledgers -> nature must win
  # x3 doi-less, container ledger only
  # x4 doi-less, no source at all -> absent from patch
  # x5 already carries the DOI its url yields -> skipped as a no-op
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('RePEc:x:1', NULL, 'https://doi.org/10.1016/j.a.1'),
    ('RePEc:x:2', NULL, 'https://www.nature.com/articles/nature999'),
    ('RePEc:x:3', NULL, NULL),
    ('RePEc:x:4', NULL, NULL),
    ('RePEc:x:5', '10.1016/j.e.5', 'https://doi.org/10.1016/j.e.5')")
  DBI::dbDisconnect(con, shutdown = TRUE)

  rds_dir <- file.path(dir, "rds"); dir.create(rds_dir)   # empty -> no redif rows

  # nature ledger resolves x2; container ledger ALSO claims x2 (nature must win) + x3
  write_parquet_df(tibble::tibble(Handle = "RePEc:x:2", doi = "10.1038/nature999",
                                  sim = 0.9, attempted_at = Sys.time()),
                   file.path(dir, "nature_attempts.parquet"))
  write_parquet_df(tibble::tibble(Handle = c("RePEc:x:2", "RePEc:x:3"),
                                  doi = c("10.9999/wrong", "10.1016/j.b.3"),
                                  sim = c(0.7, 0.8), cr_type = "journal-article",
                                  score = 50, attempted_at = Sys.time()),
                   file.path(dir, "crossref_container_attempts.parquet"))

  manifest <- finalize_doi_patch(db_path = db_path, rds_folder = rds_dir, pqt_patch_folder = dir)
  expect_false(is.null(manifest))
  patch <- read_parquet_df(sub("\\.manifest\\.json$", ".parquet", manifest))

  # x1 url; x2 nature beats container; x3 container; x4 absent; x5 no-op skipped
  expect_setequal(patch$Handle, c("RePEc:x:1", "RePEc:x:2", "RePEc:x:3"))
  expect_equal(patch$doi[patch$Handle == "RePEc:x:2"], "10.1038/nature999")  # nature > container
  expect_equal(patch$doi_source[patch$Handle == "RePEc:x:1"], "url")
  expect_equal(patch$doi_source[patch$Handle == "RePEc:x:3"], "crossref_container")
})

test_that("finalize_doi_patch overwrites a stale DOI but skips an equal one", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR, url VARCHAR)")
  # y1 carries a STALE doi but its url now yields a DIFFERENT one -> must overwrite
  # y2 carries a doi equal to what the nature ledger holds -> must be skipped (no-op)
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('RePEc:y:1', '10.1016/j.stale.1', 'https://doi.org/10.1016/j.fresh.1'),
    ('RePEc:y:2', '10.1038/nature222', 'https://www.nature.com/articles/nature222')")
  DBI::dbDisconnect(con, shutdown = TRUE)

  rds_dir <- file.path(dir, "rds"); dir.create(rds_dir)
  write_parquet_df(tibble::tibble(Handle = "RePEc:y:2", doi = "10.1038/nature222",
                                  sim = 0.9, attempted_at = Sys.time()),
                   file.path(dir, "nature_attempts.parquet"))

  manifest <- finalize_doi_patch(db_path = db_path, rds_folder = rds_dir, pqt_patch_folder = dir)
  patch <- read_parquet_df(sub("\\.manifest\\.json$", ".parquet", manifest))

  expect_setequal(patch$Handle, "RePEc:y:1")                     # y2 no-op dropped
  expect_equal(patch$doi[patch$Handle == "RePEc:y:1"], "10.1016/j.fresh.1")  # overwrites stale
  expect_equal(patch$doi_source[patch$Handle == "RePEc:y:1"], "url")
})

test_that("fuzzy ledgers only fill doi-less handles, never overwrite an existing DOI", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR, url VARCHAR)")
  # z1 already has a DOI; a container ledger hit disagrees -> must be IGNORED
  # z2 is doi-less; same container ledger fills it -> must be applied
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('RePEc:z:1', '10.1016/j.real.1', 'http://www.sciencedirect.com/x/1'),
    ('RePEc:z:2', NULL,               'http://www.sciencedirect.com/x/2')")
  DBI::dbDisconnect(con, shutdown = TRUE)

  rds_dir <- file.path(dir, "rds"); dir.create(rds_dir)
  write_parquet_df(tibble::tibble(
    Handle = c("RePEc:z:1", "RePEc:z:2"),
    doi = c("10.9999/fuzzy.wrong", "10.1016/j.real.2"),
    sim = 0.9, cr_type = "journal-article", score = 60, attempted_at = Sys.time()),
    file.path(dir, "crossref_container_attempts.parquet"))

  manifest <- finalize_doi_patch(db_path = db_path, rds_folder = rds_dir, pqt_patch_folder = dir)
  patch <- read_parquet_df(sub("\\.manifest\\.json$", ".parquet", manifest))

  expect_setequal(patch$Handle, "RePEc:z:2")                       # z1 NOT overwritten
  expect_equal(patch$doi[patch$Handle == "RePEc:z:2"], "10.1016/j.real.2")
})

test_that("finalize_doi_patch returns NULL when every candidate is a no-op", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR, url VARCHAR)")
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('RePEc:z:1', '10.1016/j.z.1', 'https://doi.org/10.1016/j.z.1')")
  DBI::dbDisconnect(con, shutdown = TRUE)
  rds_dir <- file.path(dir, "rds"); dir.create(rds_dir)

  expect_null(finalize_doi_patch(db_path = db_path, rds_folder = rds_dir, pqt_patch_folder = dir))
})
