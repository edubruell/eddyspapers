# Snapshot DOI matcher — guard behavior on the failure modes that live
# validation surfaced (stopword/number collisions, OpenAlex foreign-DOI noise,
# subtitle truncation, generic short titles).

# Build a tiny corpus DB + a works parquet fixture, both in a tempdir.
snapshot_fixture <- function(dir) {
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles
    (Handle VARCHAR, title VARCHAR, year INTEGER, journal VARCHAR, url VARCHAR, doi VARCHAR)")
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('P1','The effect of minimum wages on teenage employment',2010,'Test Econ J','http://www.sciencedirect.com/p1',NULL),
    ('P2','New estimates of British unemployment, 1870-1913',2010,'Test Econ J','http://www.sciencedirect.com/p2',NULL),
    ('P3','A stochastic frontier analysis of energy efficiency: evidence from OECD panel data',2010,'Test Econ J','http://www.sciencedirect.com/p3',NULL),
    ('P4','Introduction',2010,'Test Econ J','http://www.sciencedirect.com/p4',NULL),
    ('P5','The wonderful widget theorem in decentralized markets',2010,'Test Econ J','http://www.sciencedirect.com/p5',NULL),
    ('P6','A paper that has no match at all in the works table',2010,'Test Econ J','http://www.sciencedirect.com/p6',NULL)")
  DBI::dbDisconnect(con, shutdown = TRUE)

  # Works for source S1. Ten 10.1017 works establish the dominant prefix; one
  # 10.5555 work is the foreign-DOI noise (must be rejected by the prefix guard).
  mk <- function(id, doi, title) tibble::tibble(
    id = id, doi = doi, title = title, year = 2010L, type = "article", src_id = "S1")
  works <- dplyr::bind_rows(
    mk("W1", "https://doi.org/10.1017/exact", "The effect of minimum wages on teenage employment"),      # -> P1 accept
    mk("W2", "https://doi.org/10.1017/collision", "New indices of British equity prices, 1870-1913"),     # -> P2 reject (collision)
    mk("W3", "https://doi.org/10.1017/trunc", "A stochastic frontier analysis of energy efficiency"),     # -> P3 accept (truncation)
    mk("W4", "https://doi.org/10.1017/intro", "Introduction"),                                            # -> P4 reject (generic)
    mk("W5", "https://doi.org/10.5555/foreign", "The wonderful widget theorem in decentralized markets"), # -> P5 reject (foreign DOI)
    mk("F1","https://doi.org/10.1017/f1","Filler alpha about interest rate policy rules"),
    mk("F2","https://doi.org/10.1017/f2","Filler bravo concerning exchange rate regimes"),
    mk("F3","https://doi.org/10.1017/f3","Filler charlie on fiscal multipliers in recessions"),
    mk("F4","https://doi.org/10.1017/f4","Filler delta regarding labor market frictions"),
    mk("F5","https://doi.org/10.1017/f5","Filler echo studying housing wealth effects"))
  works_path <- file.path(dir, "works.parquet")
  write_parquet_df(works, works_path)
  list(db_path = db_path, works_glob = works_path,
       srcmap = tibble::tibble(journal = "Test Econ J", src_id = "S1"))
}

test_that("exact stage matches exact titles, rejects collisions/generic/foreign", {
  dir <- withr::local_tempdir()
  fx  <- snapshot_fixture(dir)
  # prefix_min_share 0.2 so the single foreign DOI (1/11 ~ 9%) fails on the
  # small fixture; on real data the default 0.05 works with hundreds of works.
  hits <- snapshot_match_container_dois(fx$db_path, fx$works_glob, fx$srcmap,
                                        prefix_min_share = 0.2)
  got <- setNames(hits$doi, hits$Handle)
  expect_equal(unname(got["P1"]), "10.1017/exact")   # exact title
  expect_false("P2" %in% hits$Handle)                # stopword/number collision rejected
  expect_false("P3" %in% hits$Handle)                # truncation is NOT exact -> not in exact stage
  expect_false("P4" %in% hits$Handle)                # generic 1-token title rejected
  expect_false("P5" %in% hits$Handle)                # foreign-DOI noise rejected by prefix guard
  expect_false("P6" %in% hits$Handle)                # no candidate
  expect_true(all(hits$match_type == "exact"))
})

test_that("fuzzy stage recovers subtitle-truncation matches, still rejects collisions", {
  dir <- withr::local_tempdir()
  fx  <- snapshot_fixture(dir)
  hits <- snapshot_match_container_dois(fx$db_path, fx$works_glob, fx$srcmap,
                                        prefix_min_share = 0.2, fuzzy = TRUE)
  got <- setNames(hits$doi, hits$Handle)
  expect_equal(unname(got["P1"]), "10.1017/exact")   # still exact
  expect_equal(unname(got["P3"]), "10.1017/trunc")   # truncation recovered via containment
  expect_false("P2" %in% hits$Handle)                # collision still rejected (containment 0.33)
  expect_false("P5" %in% hits$Handle)                # foreign DOI still rejected
  expect_equal(hits$match_type[hits$Handle == "P3"], "fuzzy")
})

test_that("snapshot matcher normalizes DOIs and returns typed columns", {
  dir <- withr::local_tempdir()
  fx  <- snapshot_fixture(dir)
  hits <- snapshot_match_container_dois(fx$db_path, fx$works_glob, fx$srcmap, prefix_min_share = 0.2)
  expect_named(hits, c("Handle", "doi", "content_sim", "match_type"))
  expect_true(all(grepl("^10\\.", hits$doi)))        # resolver-stripped, lowercase
})

# Sources parquet needs alternate_titles typed VARCHAR[]; an all-empty R list
# column round-trips through DuckDB as BLOB, so build the fixture with DDL.
make_sources_parquet <- function(path, id, display_name, works_count) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, "CREATE TABLE s (id VARCHAR, issn_l VARCHAR, issn VARCHAR[],
    display_name VARCHAR, alternate_titles VARCHAR[], works_count INTEGER,
    host_organization_name VARCHAR, type VARCHAR, last_publication_year INTEGER)")
  vals <- paste(sprintf("('%s',NULL,NULL,'%s',NULL,%d,NULL,'journal',2026)",
                        id, gsub("'", "''", display_name), works_count), collapse = ",")
  DBI::dbExecute(con, paste("INSERT INTO s VALUES", vals))
  DBI::dbExecute(con, sprintf("COPY s TO '%s' (FORMAT parquet)", path))
}

test_that("resolve_container_sources matches name variants (&/and, behaviour, leading The, parenthetical)", {
  dir <- withr::local_tempdir()
  sp <- file.path(dir, "sources.parquet")
  make_sources_parquet(sp,
    c("S10", "S11", "S12", "S13"),
    c("Journal of Banking & Finance", "Games and Economic Behavior",
      "The Journal of Finance", "Journal of Economic Theory"),
    c(7000L, 4000L, 16000L, 6000L))

  res <- resolve_container_sources(
    c("Journal of Banking and Finance", "Games and Economic Behaviour",
      "Journal of Finance", "Journal of Economic Theory (JET)"), sp)
  by <- setNames(res$src_id, res$journal)
  expect_equal(unname(by["Journal of Banking and Finance"]), "S10")   # & vs and
  expect_equal(unname(by["Games and Economic Behaviour"]), "S11")     # British spelling
  expect_equal(unname(by["Journal of Finance"]), "S12")               # leading The
  expect_equal(unname(by["Journal of Economic Theory (JET)"]), "S13") # parenthetical
})

test_that("resolve_container_sources breaks ties by works_count", {
  dir <- withr::local_tempdir()
  sp <- file.path(dir, "sources.parquet")
  make_sources_parquet(sp, c("small", "big"),
                       c("Economics Letters", "Economics Letters"), c(50L, 15000L))
  res <- resolve_container_sources("Economics Letters", sp)
  expect_equal(res$src_id, "big")
})

test_that("container_doi_less_journals returns only doi-less container-host journals", {
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles
    (Handle VARCHAR, title VARCHAR, year INTEGER, journal VARCHAR, url VARCHAR, doi VARCHAR)")
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('a','t',2010,'Elsevier J','http://www.sciencedirect.com/a',NULL),
    ('b','t',2010,'Elsevier J','http://www.sciencedirect.com/b',NULL),
    ('c','t',2010,'Has DOI J','http://www.sciencedirect.com/c','10.1016/x'),
    ('d','t',2010,'Repo J','http://mpra.ub.uni-muenchen.de/d',NULL)")
  DBI::dbDisconnect(con, shutdown = TRUE)
  js <- container_doi_less_journals(db_path)
  expect_equal(js$journal, "Elsevier J")   # not the DOI'd one, not the non-container host
  expect_equal(js$n, 2L)
})
