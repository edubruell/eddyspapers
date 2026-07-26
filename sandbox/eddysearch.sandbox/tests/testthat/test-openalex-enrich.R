oa_test_con <- function() {
  con <- DBI::dbConnect(duckdb::duckdb(), ":memory:")
  DBI::dbExecute(con, "
    CREATE TABLE article_openalex (
      handle VARCHAR, openalex_id VARCHAR, doi VARCHAR,
      oa_cited_by_count INTEGER, fwci DOUBLE, pctl_value DOUBLE,
      is_top1 BOOLEAN, is_top10 BOOLEAN, is_retracted BOOLEAN,
      is_oa BOOLEAN, oa_status VARCHAR, oa_url VARCHAR,
      primary_topic VARCHAR, primary_field VARCHAR
    )")
  # Row stored lowercase, queried mixed-case → proves the LOWER-join.
  DBI::dbExecute(con, "
    INSERT INTO article_openalex VALUES
      ('repec:aea:x:1','https://openalex.org/W1','10.1/x',
       42, 1.75, 0.9, false, true, true, true, 'gold','https://oa/1',
       'Labour economics','Economics')")
  con
}

oa_candidates <- tibble::tibble(
  Handle = c("RePEc:aea:x:1", "RePEc:none:n:4"),
  title  = c("Matched", "Unmatched")
)

test_that("enrich_openalex left-joins the block on the mixed-case handle", {
  con <- oa_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- enrich_openalex(con, oa_candidates)
  expect_true(all(c("fwci", "oa_url", "is_retracted", "openalex_id") %in% names(out)))
  matched <- out[out$Handle == "RePEc:aea:x:1", ]
  expect_equal(matched$fwci, 1.75)
  expect_true(matched$is_retracted)
  expect_equal(matched$oa_url, "https://oa/1")
  # An unmatched handle keeps its row with NA metrics (LEFT JOIN, never dropped).
  unmatched <- out[out$Handle == "RePEc:none:n:4", ]
  expect_true(is.na(unmatched$openalex_id))
})

test_that("enrich_openalex is a no-op when the table is absent", {
  con <- DBI::dbConnect(duckdb::duckdb(), ":memory:")
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  out <- enrich_openalex(con, oa_candidates)
  expect_identical(out, oa_candidates)
})

test_that("enrich_openalex tolerates a NULL connection and empty frames", {
  expect_identical(enrich_openalex(NULL, oa_candidates), oa_candidates)
  empty <- oa_candidates[0, ]
  expect_identical(enrich_openalex(NULL, empty), empty)
})

# The data verbs enrich their result frames, so by the time a frame reaches emit_section it
# already carries the openalex columns. make_paper_event must pass a present block through and
# omit it when the enrichment left NA (unmatched work) or the columns are absent entirely.
test_that("emit_section passes an enriched openalex block through to the paper event", {
  con <- oa_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  .sandbox_state$seen_handles <- character(0)

  df <- enrich_openalex(con, tibble::tibble(
    Handle = "RePEc:aea:x:1", title = "Matched", year = 2019L,
    authors = "Card", journal = "AER", category = "A", url = ""
  ))
  events <- capture_events(emit_section("OA", df))
  paper <- Filter(function(e) e$type == "paper", events)[[1]]
  expect_false(is.null(paper$openalex))
  expect_equal(paper$openalex$fwci, 1.75)
  expect_true(paper$openalex$is_retracted)
  expect_equal(paper$openalex$oa_url, "https://oa/1")
})

test_that("emit_section keeps the block but nulls an individual NA field of a matched work", {
  con <- oa_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  # A matched work whose openalex_id anchors the block but with NULL fwci/oa_url — the
  # per-field na_null path must drop only those keys, never the whole block.
  DBI::dbExecute(con, "
    INSERT INTO article_openalex VALUES
      ('repec:aea:x:2','https://openalex.org/W2','10.1/y',
       7, NULL, NULL, false, false, false, false, 'closed', NULL,
       'Trade','Economics')")
  .sandbox_state$seen_handles <- character(0)

  df <- enrich_openalex(con, tibble::tibble(
    Handle = "RePEc:aea:x:2", title = "PartialMatch", year = 2020L,
    authors = "Y", journal = "JIE", category = "A", url = ""
  ))
  events <- capture_events(emit_section("OA", df))
  paper <- Filter(function(e) e$type == "paper", events)[[1]]
  expect_false(is.null(paper$openalex))
  expect_equal(paper$openalex$openalex_id, "https://openalex.org/W2")
  expect_equal(paper$openalex$oa_cited_by_count, 7)
  expect_null(paper$openalex$fwci)    # NA → dropped/null, block survives
  expect_null(paper$openalex$oa_url)
})

test_that("emit_section omits openalex for an enriched-but-unmatched row", {
  con <- oa_test_con()
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  .sandbox_state$seen_handles <- character(0)

  df <- enrich_openalex(con, tibble::tibble(
    Handle = "RePEc:none:n:4", title = "Unmatched", year = 2019L,
    authors = "X", journal = "WP", category = "A", url = ""
  ))
  events <- capture_events(emit_section("OA", df))
  paper <- Filter(function(e) e$type == "paper", events)[[1]]
  expect_null(paper$openalex)
})

test_that("emit_section omits openalex when the frame was never enriched (no columns)", {
  .sandbox_state$seen_handles <- character(0)
  df <- tibble::tibble(
    Handle = "repec:test:1", title = "Plain", year = 2019L,
    authors = "X", journal = "WP", category = "A", url = ""
  )
  events <- capture_events(emit_section("Plain", df))
  paper <- Filter(function(e) e$type == "paper", events)[[1]]
  expect_null(paper$openalex)
})
