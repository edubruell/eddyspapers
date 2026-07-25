# OpenAlex metrics enrichment (Track B). The worker projection SQL runs against
# a local nested-struct works fixture (same shape as the snapshot) so DOI
# normalization, struct flattening, JSON serialization and the type/DOI filters
# are exercised without touching S3; build_article_openalex is tested for
# DOI-dedup (freshest wins) and handle fan-out.

# A works parquet with the nested columns oa_metrics_select_sql reaches into.
make_works_fixture <- function(path) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, "CREATE TABLE works AS SELECT * FROM (VALUES
    ('W1','https://doi.org/10.1017/AbC','article',42,false,2.5,
       {'value':0.98,'is_in_top_1_percent':true,'is_in_top_10_percent':true},
       {'is_oa':true,'oa_status':'green','oa_url':'http://oa/1'},
       {'display_name':'Minimum wage','field':{'display_name':'Economics'}},
       [{'year':2022,'cited_by_count':10},{'year':2023,'cited_by_count':32}],
       [{'id':'F1','display_name':'NSF','ror':'ror1'}],
       {'source':{'display_name':'Test Econ J','issn_l':'1234-5678'}},
       7,2010,DATE '2025-11-06'),
    ('W2','https://dx.doi.org/10.1016/J.XYz','review',5,false,NULL,
       {'value':NULL,'is_in_top_1_percent':false,'is_in_top_10_percent':false},
       {'is_oa':false,'oa_status':'closed','oa_url':NULL},
       {'display_name':'Energy','field':{'display_name':'Energy'}},
       [],[],
       {'source':{'display_name':'Energy J','issn_l':NULL}},
       0,2015,DATE '2026-05-21'),
    ('W3','https://doi.org/10.9999/para','paratext',1,false,NULL,
       {'value':NULL,'is_in_top_1_percent':false,'is_in_top_10_percent':false},
       {'is_oa':false,'oa_status':'closed','oa_url':NULL},
       {'display_name':NULL,'field':{'display_name':NULL}},
       [],[],{'source':{'display_name':NULL,'issn_l':NULL}},0,2010,DATE '2025-11-06'),
    ('W4','https://doi.org/10.1017/notincorpus','article',9,false,1.0,
       {'value':0.5,'is_in_top_1_percent':false,'is_in_top_10_percent':false},
       {'is_oa':true,'oa_status':'gold','oa_url':'http://oa/4'},
       {'display_name':'Other','field':{'display_name':'Other'}},
       [],[],{'source':{'display_name':'Other J','issn_l':NULL}},2,2011,DATE '2025-11-06'),
    ('W5','https://doi.org/10.1017/abc','article',30,false,2.1,
       {'value':0.90,'is_in_top_1_percent':false,'is_in_top_10_percent':true},
       {'is_oa':true,'oa_status':'green','oa_url':'http://oa/old'},
       {'display_name':'Minimum wage','field':{'display_name':'Economics'}},
       [{'year':2022,'cited_by_count':9}],[],
       {'source':{'display_name':'Test Econ J','issn_l':'1234-5678'}},
       7,2010,DATE '2024-01-01')
    ) AS t(id,doi,type,cited_by_count,is_retracted,fwci,
           citation_normalized_percentile,open_access,primary_topic,
           counts_by_year,funders,primary_location,referenced_works_count,
           publication_year,updated_date)")
  DBI::dbExecute(con, sprintf("COPY works TO '%s' (FORMAT parquet)", path))
}

make_dois_fixture <- function(path, dois) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  duckdb::duckdb_register(con, "d", data.frame(doi = dois))
  DBI::dbExecute(con, sprintf("COPY (SELECT doi FROM d) TO '%s' (FORMAT parquet)", path))
}

test_that("worker projects, normalizes DOIs, flattens structs, filters type + corpus DOI", {
  dir <- withr::local_tempdir()
  wp <- file.path(dir, "works.parquet"); make_works_fixture(wp)
  dp <- file.path(dir, "dois.parquet")
  make_dois_fixture(dp, c("10.1017/abc", "10.1016/j.xyz", "10.9999/para"))
  out <- file.path(dir, "meta.parquet")
  pull_oa_meta_worker(wp, out, dp, threads = 1L)

  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  m <- DBI::dbGetQuery(con, sprintf("SELECT * FROM read_parquet('%s') ORDER BY openalex_id", out))
  # W3 paratext dropped; W4 (doi not in corpus) dropped -> W1,W2,W5 kept
  expect_setequal(m$openalex_id, c("W1", "W2", "W5"))
  w1 <- m[m$openalex_id == "W1", ]
  expect_equal(w1$doi, "10.1017/abc")           # resolver stripped + lowercased
  expect_equal(w1$oa_cited_by_count, 42L)
  expect_equal(w1$fwci, 2.5)
  expect_true(w1$is_top1); expect_true(w1$is_top10)
  expect_equal(w1$oa_status, "green")
  expect_equal(w1$primary_field, "Economics")
  expect_equal(w1$venue, "Test Econ J")
  expect_equal(w1$issn_l, "1234-5678")
  expect_match(w1$counts_by_year, "2023")       # JSON string
  # W2 lowercases the mixed-case DOI reached via dx.doi.org
  expect_equal(m[m$openalex_id == "W2", ]$doi, "10.1016/j.xyz")
})

test_that("build_article_openalex dedups DOI (freshest wins) and fans out to handles", {
  dir <- withr::local_tempdir()
  wp <- file.path(dir, "works.parquet"); make_works_fixture(wp)
  dp <- file.path(dir, "dois.parquet")
  make_dois_fixture(dp, c("10.1017/abc", "10.1016/j.xyz"))
  meta <- file.path(dir, "meta.parquet")
  pull_oa_meta_worker(wp, meta, dp, threads = 1L)

  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR)")
  DBI::dbExecute(con, "INSERT INTO articles VALUES
    ('H1','10.1017/abc'),('H2','10.1017/ABC'),('H3','10.1016/j.xyz'),('H4',NULL)")
  DBI::dbDisconnect(con, shutdown = TRUE)

  rows <- build_article_openalex(meta, db_path)
  # two handles share the abc DOI -> both present; NULL-doi handle excluded
  expect_setequal(rows$handle, c("H1", "H2", "H3"))
  abc <- rows[rows$handle == "H1", ]
  expect_equal(abc$openalex_id, "W1")           # freshest (2025-11-06) beats W5 (2024)
  expect_equal(abc$oa_cited_by_count, 42L)
  # both abc handles carry identical metrics
  expect_equal(rows[rows$handle == "H2", ]$openalex_id, "W1")
})

# A works fixture with one fully-typed row (anchors the struct field types) and
# one matched row whose every metric leaf is NULL — exercises null-struct-field
# access in the projection (a matched DOI must survive with NA metrics).
make_null_works_fixture <- function(path) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, "CREATE TABLE works AS SELECT * FROM (VALUES
    ('WT','https://doi.org/10.1/typed','article',1,false,1.0,
       {'value':0.1,'is_in_top_1_percent':false,'is_in_top_10_percent':false},
       {'is_oa':true,'oa_status':'gold','oa_url':'u'},
       {'display_name':'T','field':{'display_name':'F'}},
       [{'year':2020,'cited_by_count':1}],[{'id':'F','display_name':'n','ror':'r'}],
       {'source':{'display_name':'V','issn_l':'1-1'}},1,2020,DATE '2025-01-01'),
    ('WN','https://doi.org/10.1/NULLS','article',NULL,NULL,NULL,
       {'value':NULL,'is_in_top_1_percent':NULL,'is_in_top_10_percent':NULL},
       {'is_oa':NULL,'oa_status':NULL,'oa_url':NULL},
       {'display_name':NULL,'field':{'display_name':NULL}},
       NULL,NULL,
       {'source':{'display_name':NULL,'issn_l':NULL}},NULL,NULL,DATE '2025-02-02')
    ) AS t(id,doi,type,cited_by_count,is_retracted,fwci,
           citation_normalized_percentile,open_access,primary_topic,
           counts_by_year,funders,primary_location,referenced_works_count,
           publication_year,updated_date)")
  DBI::dbExecute(con, sprintf("COPY works TO '%s' (FORMAT parquet)", path))
}

# A flat metrics parquet in exactly the shape build_article_openalex reads, so
# the dedup/tie-break and no-match paths can be driven with precise
# doi/updated_date/cited values without going through S3 or struct fixtures.
make_flat_meta <- function(path, values_sql) {
  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, sprintf("COPY (SELECT * FROM (VALUES %s) AS t(
     openalex_id, doi, oa_cited_by_count, fwci, pctl_value, is_top1, is_top10,
     is_retracted, is_oa, oa_status, oa_url, primary_topic, primary_field,
     counts_by_year, funders, venue, issn_l, referenced_works_count, oa_year,
     updated_date)) TO '%s' (FORMAT parquet)", values_sql, path))
}

make_articles_db <- function(db_path, values_sql) {
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR)")
  DBI::dbExecute(con, sprintf("INSERT INTO articles VALUES %s", values_sql))
  DBI::dbDisconnect(con, shutdown = TRUE)
}

test_that("worker keeps a matched DOI whose metric leaves are all NULL", {
  dir <- withr::local_tempdir()
  wp <- file.path(dir, "works.parquet"); make_null_works_fixture(wp)
  dp <- file.path(dir, "dois.parquet")
  make_dois_fixture(dp, c("10.1/nulls"))     # only the all-NULL row is in corpus
  out <- file.path(dir, "meta.parquet")
  pull_oa_meta_worker(wp, out, dp, threads = 1L)

  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  m <- DBI::dbGetQuery(con, sprintf("SELECT * FROM read_parquet('%s')", out))
  expect_equal(nrow(m), 1L)
  expect_equal(m$openalex_id, "WN")
  expect_equal(m$doi, "10.1/nulls")          # matched + normalized despite NULL metrics
  expect_true(is.na(m$oa_cited_by_count))
  expect_true(is.na(m$fwci))
  expect_true(is.na(m$is_top1))
  expect_true(is.na(m$oa_status))
  expect_true(is.na(m$primary_field))
  expect_true(is.na(m$venue))
  expect_true(is.na(m$counts_by_year))       # to_json(NULL) -> SQL NULL, not '[]'
  expect_true(is.na(m$funders))
})

test_that("build dedup tie-breaks equal updated_date by oa_cited_by_count", {
  dir <- withr::local_tempdir()
  meta <- file.path(dir, "meta.parquet")
  make_flat_meta(meta, "
    ('W_LO','10.5/x',10,1.0,0.5,false,false,false,true,'gold',NULL,'T','F',
       '[]','[]','V',NULL,3,2020,DATE '2025-01-01'),
    ('W_HI','10.5/x',99,2.0,0.9,true,true,false,true,'gold',NULL,'T','F',
       '[]','[]','V',NULL,3,2020,DATE '2025-01-01')")
  db_path <- file.path(dir, "articles.duckdb")
  make_articles_db(db_path, "('H','10.5/x')")

  rows <- build_article_openalex(meta, db_path)
  expect_equal(nrow(rows), 1L)
  expect_equal(rows$openalex_id, "W_HI")     # same date -> higher cited wins
  expect_equal(rows$oa_cited_by_count, 99L)
})

test_that("build returns a well-formed empty result when no DOI matches", {
  dir <- withr::local_tempdir()
  meta <- file.path(dir, "meta.parquet")
  make_flat_meta(meta, "
    ('W1','10.5/x',10,1.0,0.5,false,false,false,true,'gold',NULL,'T','F',
       '[]','[]','V',NULL,3,2020,DATE '2025-01-01')")
  db_path <- file.path(dir, "articles.duckdb")
  make_articles_db(db_path, "('H','10.99/none'),('H2',NULL)")

  rows <- build_article_openalex(meta, db_path)
  expect_equal(nrow(rows), 0L)
  expect_true(all(c("handle", "openalex_id", "oa_cited_by_count", "updated_date")
                  %in% names(rows)))
})

test_that("openalex_metrics_patch writes a valid replace_table manifest", {
  dir <- withr::local_tempdir()
  meta <- file.path(dir, "meta.parquet")
  make_flat_meta(meta, "
    ('W1','10.5/x',10,1.0,0.5,false,false,false,true,'gold',NULL,'T','F',
       '[]','[]','V',NULL,3,2020,DATE '2025-01-01')")
  db_path <- file.path(dir, "articles.duckdb")
  make_articles_db(db_path, "('H1','10.5/x'),('H2','10.5/X')")
  patch_dir <- file.path(dir, "patches")

  mpath <- openalex_metrics_patch(meta, db_path = db_path, pqt_patch_folder = patch_dir)
  man <- jsonlite::read_json(mpath, simplifyVector = TRUE)
  expect_equal(man$target_table, "article_openalex")
  expect_equal(man$mode, "replace_table")
  expect_length(man$key_cols, 0)             # replace_table carries no key
  expect_equal(man$rows, 2L)                 # both case-variant handles fan out
  parquet_path <- file.path(patch_dir, paste0(man$patch_id, ".parquet"))
  expect_true(file.exists(parquet_path))
})

test_that("replace_table patch applies and migrate_schema restores the indices", {
  dir <- withr::local_tempdir()
  meta <- file.path(dir, "meta.parquet")
  make_flat_meta(meta, "
    ('W1','10.5/x',10,1.0,0.5,false,false,false,true,'gold',NULL,'T','F',
       '[]','[]','V',NULL,3,2020,DATE '2025-01-01')")
  db_path <- file.path(dir, "articles.duckdb")
  make_articles_db(db_path, "('H1','10.5/x')")
  patch_dir <- file.path(dir, "patches")
  mpath <- openalex_metrics_patch(meta, db_path = db_path, pqt_patch_folder = patch_dir)

  con <- DBI::dbConnect(duckdb::duckdb()); on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR)")  # migrate_schema ALTERs it
  apply_patch(con, mpath)
  n <- DBI::dbGetQuery(con, "SELECT count(*) n FROM article_openalex")$n
  expect_equal(n, 1L)
  idx <- DBI::dbGetQuery(con,
    "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'article_openalex'")$index_name
  expect_true(all(c("idx_article_openalex_handle", "idx_article_openalex_doi") %in% idx))
})

test_that("dump_db_to_parquet includes article_openalex in the baseline", {
  # Regression guard: the table must be in the dump allowlist or it is silently
  # dropped from the baseline and comes back empty on restore-from-parquet.
  dir <- withr::local_tempdir()
  db_path <- file.path(dir, "articles.duckdb")
  con <- DBI::dbConnect(duckdb::duckdb(), db_path)
  DBI::dbExecute(con, "CREATE TABLE articles (Handle VARCHAR, doi VARCHAR)")
  migrate_schema(con)
  DBI::dbExecute(con, "INSERT INTO article_openalex (handle, doi) VALUES ('H1','10.5/x')")
  DBI::dbDisconnect(con, shutdown = TRUE)

  pqt <- file.path(dir, "pqt")
  dump_db_to_parquet(db_path = db_path, pqt_folder = pqt)
  expect_true(length(list.files(pqt, pattern = "^article_openalex_.*\\.parquet$")) == 1L)
})
