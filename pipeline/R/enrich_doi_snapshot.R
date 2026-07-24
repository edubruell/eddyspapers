# OpenAlex snapshot DOI backfill (Wave 2) ------------------------------------
#
# The container-title route via the OpenAlex *API* is paid ($0.001/request, ~1k
# free/day — see 04_tiered_doi.md), so the ~137k publisher-journal DOIs come
# from the free CC0 quarterly S3 parquet snapshot instead. We resolve our
# target journals to OpenAlex source ids, pull just those journals' works once
# into a local parquet, then match DOI-less corpus papers to them by
# source + year + Jaccard title similarity — identical guard to the API route
# (`openalex_pick_best`), zero per-request cost. The same local subset seeds the
# Wave-2 `article_openalex` metrics table.

OA_S3_PARQUET <- "s3://openalex/data/parquet"

# Configure a DuckDB connection for anonymous public-bucket reads. OpenAlex's
# bucket needs no credentials; an empty-key secret + region is enough.
oa_s3_setup <- function(con) {
  DBI::dbExecute(con, "INSTALL httpfs; LOAD httpfs;")
  DBI::dbExecute(con, "SET s3_region='us-east-1';")
  DBI::dbExecute(con, "SET http_retries=8; SET http_timeout=300000;")
  try(DBI::dbExecute(con, "CREATE SECRET oa (TYPE s3, PROVIDER config, KEY_ID '', SECRET '');"),
      silent = TRUE)
  invisible(con)
}

# --- Corpus side: container journals to resolve -----------------------------

#' DOI-less container-host journals in the corpus
#'
#' The distinct journals (with paper counts) of DOI-less articles on trusted
#' publisher hosts — the set the snapshot route resolves and backfills. Shares
#' `container_host_patterns()` with the Crossref/API routes so all three target
#' the same population.
#'
#' @param db_path Corpus DuckDB (read-only)
#' @param hosts URL host substrings. Defaults to `container_host_patterns()`
#' @return Tibble (journal, n) ordered by descending count
#' @export
container_doi_less_journals <- function(db_path, hosts = NULL) {
  if (is.null(hosts)) hosts <- container_host_patterns()
  con <- get_db_con(db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  host_clause <- paste(sprintf("lower(url) LIKE '%%%s%%'", hosts), collapse = " OR ")
  DBI::dbGetQuery(con, sprintf("
    SELECT journal, count(*) AS n FROM articles
    WHERE doi IS NULL AND journal IS NOT NULL AND title IS NOT NULL AND year IS NOT NULL
      AND (%s)
    GROUP BY journal ORDER BY n DESC", host_clause)) |>
    tibble::as_tibble()
}

# --- Journal -> OpenAlex source resolution ----------------------------------

# Normalized-name SQL for a column: lowercase, '&' -> ' and ', drop
# parentheticals, British 'behaviour' -> 'behavior', punctuation -> space,
# collapse, strip a leading 'the '. Deliberately matches the way well-known
# econ journal titles differ between RePEc and OpenAlex.
oa_name_norm_sql <- function(col) {
  sprintf("trim(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(lower(%s),
      '&',' and ','g'), '\\([^)]*\\)','','g'),
      'behaviour','behavior','g'),
    '[^a-z0-9]+',' ','g'),
  '^the ',''))", col)
}

#' Cache OpenAlex journal sources to a local parquet
#'
#' Reads the (small) OpenAlex `sources` snapshot over httpfs and writes the
#' `type = 'journal'` rows locally so journal resolution runs offline.
#'
#' @param out_path Destination parquet path
#' @param con Optional DuckDB connection (a temp one is created if NULL)
#' @return `out_path` (invisibly)
#' @export
cache_openalex_sources <- function(out_path, con = NULL) {
  if (is.null(con)) {
    con <- DBI::dbConnect(duckdb::duckdb())
    on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  }
  oa_s3_setup(con)
  DBI::dbExecute(con, sprintf("
    COPY (
      SELECT id, issn_l, issn, display_name, alternate_titles, works_count,
             host_organization_name, type, last_publication_year
      FROM read_parquet('%s/sources/*/*.parquet')
      WHERE type = 'journal'
    ) TO '%s' (FORMAT parquet)", OA_S3_PARQUET, out_path))
  info("Cached OpenAlex journal sources -> ", out_path)
  invisible(out_path)
}

#' Resolve journal names to OpenAlex source ids
#'
#' Matches each input journal name to an OpenAlex journal source by normalized
#' `display_name` or `alternate_titles`, breaking ties by `works_count` (the
#' canonical high-volume source wins over spurious tiny namesakes). Only the
#' single best source per input journal is returned; unmatched journals get
#' `src_id = NA`.
#'
#' @param journals Character vector of journal names (or a data frame with a
#'   `journal` column)
#' @param sources_path Local parquet from `cache_openalex_sources()`
#' @return Tibble (journal, src_id, oa_name, works_count, via)
#' @export
resolve_container_sources <- function(journals, sources_path) {
  if (is.data.frame(journals)) journals <- journals$journal
  jdf <- tibble::tibble(journal = unique(journals[!is.na(journals)]))

  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  duckdb::duckdb_register(con, "jdf", jdf)

  DBI::dbExecute(con, sprintf(
    "CREATE VIEW cj AS SELECT journal, %s AS jn FROM jdf", oa_name_norm_sql("journal")))
  DBI::dbExecute(con, sprintf("CREATE VIEW src AS
      SELECT id, display_name, works_count, %s AS sn FROM read_parquet('%s')
    UNION ALL
      SELECT id, display_name, works_count, %s AS sn
      FROM (SELECT id, display_name, works_count, unnest(alternate_titles) AS alt
            FROM read_parquet('%s') WHERE alternate_titles IS NOT NULL)",
    oa_name_norm_sql("display_name"), sources_path,
    oa_name_norm_sql("alt"), sources_path))

  res <- DBI::dbGetQuery(con, "
    WITH m AS (
      SELECT cj.journal, src.id, src.display_name, src.works_count,
             CASE WHEN src.id IS NULL THEN NULL ELSE 'name/alt' END AS via,
             row_number() OVER (PARTITION BY cj.journal
                                ORDER BY src.works_count DESC NULLS LAST) rn
      FROM cj LEFT JOIN src ON cj.jn = src.sn)
    SELECT journal, id AS src_id, display_name AS oa_name, works_count, via
    FROM m WHERE rn = 1 ORDER BY works_count DESC NULLS LAST")
  tibble::as_tibble(res)
}

# --- Works pull -------------------------------------------------------------

#' Pull OpenAlex works for given source ids into local parquet
#'
#' The works snapshot (~510M rows / 725 GB) is partitioned by `updated_date`,
#' not venue, so there is no cheap prefix filter: a single projected scan reads
#' the `primary_location.source.id` leaf across every partition. To bound the
#' blast radius of a network failure the scan is chunked by update-month; each
#' chunk writes its own file and is skipped on resume, so a failed month re-runs
#' alone. Only `article`/`review` rows in the given sources are kept.
#'
#' @param source_ids Character vector of OpenAlex source ids to keep
#' @param out_dir Directory for per-chunk parquet files
#' @param years Update-years to sweep. Defaults 2016..current
#' @param con Optional DuckDB connection
#' @return `out_dir` (invisibly)
#' @export
pull_openalex_works <- function(source_ids, out_dir, years = NULL, con = NULL) {
  stopifnot(length(source_ids) > 0)
  if (is.null(years)) years <- 2016:as.integer(format(Sys.Date(), "%Y"))
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  if (is.null(con)) {
    con <- DBI::dbConnect(duckdb::duckdb())
    on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  }
  oa_s3_setup(con)
  idlist <- paste(sprintf("'%s'", source_ids), collapse = ",")

  chunks <- c(
    list(list(name = "pre2025",
              globs = sprintf("%s/works/updated_date=%d-*/*.parquet", OA_S3_PARQUET,
                              years[years < 2025]))),
    unlist(lapply(years[years >= 2025], function(y) lapply(sprintf("%02d", 1:12), function(m)
      list(name = sprintf("%d-%s", y, m),
           globs = sprintf("%s/works/updated_date=%d-%s-*/*.parquet", OA_S3_PARQUET, y, m)))),
      recursive = FALSE))

  for (ch in chunks) {
    out <- file.path(out_dir, paste0(ch$name, ".parquet"))
    if (file.exists(out)) { info("  skip ", ch$name, " (exists)"); next }
    tmp <- paste0(out, ".tmp")
    globlist <- paste(sprintf("'%s'", ch$globs), collapse = ",")
    sql <- sprintf("COPY (
      SELECT id, doi, title, publication_year AS year, type,
             primary_location.source.id AS src_id,
             primary_location.source.display_name AS src_name,
             cited_by_count, is_retracted
      FROM read_parquet([%s], filename=false)
      WHERE type IN ('article','review')
        AND primary_location.source.id IN (%s)
    ) TO '%s' (FORMAT parquet)", globlist, idlist, tmp)
    t0 <- Sys.time()
    ok <- tryCatch({ DBI::dbExecute(con, sql); TRUE },
                   error = function(e) { info("  ERROR ", ch$name, ": ", conditionMessage(e)); FALSE })
    if (ok) {
      file.rename(tmp, out)  # rename-on-success: partial writes never look done
      info("  done ", ch$name, " in ",
           round(as.numeric(Sys.time() - t0, units = "mins"), 1), " min")
    } else if (file.exists(tmp)) file.remove(tmp)
  }
  invisible(out_dir)
}

# --- Snapshot title+year match ----------------------------------------------

# Raw token set of a normalized title: lowercase, punctuation -> space, split,
# distinct, drop empties. Jaccard over these sets equals `title_sim()` exactly.
oa_title_tokens_sql <- function(col) {
  sprintf("list_distinct(list_filter(string_split(
    trim(regexp_replace(lower(%s),'[^a-z0-9]+',' ','g')),' '), x -> x <> ''))", col)
}

# Content token set: raw tokens minus common stopwords and purely-numeric
# tokens. Bare Jaccard is fooled by titles that share only stopwords + years
# (e.g. "New Estimates of British Unemployment, 1870-1913" vs "New Indices of
# British Equity Prices, 1870-1913" -> raw Jaccard 0.5, different papers), so
# the guard scores over content tokens instead.
OA_STOPWORDS <- c("the","a","an","of","and","or","in","on","for","to","from",
                  "with","by","at","as","is","are","be","its","their","this",
                  "that","new","evidence","case","using","some","note")

oa_content_tokens_sql <- function(col) {
  stoplist <- paste(sprintf("'%s'", OA_STOPWORDS), collapse = ",")
  sprintf("list_filter(%s, x -> x NOT IN (%s) AND NOT regexp_full_match(x,'[0-9]+'))",
          oa_title_tokens_sql(col), stoplist)
}

# Order-independent key of the content-token SET, so a hash equi-join matches
# titles that differ only in word order/stopwords/punctuation.
oa_content_key_sql <- function(col) {
  sprintf("array_to_string(list_sort(%s), ' ')", oa_content_tokens_sql(col))
}

#' Match DOI-less container papers to local OpenAlex works
#'
#' For every DOI-less corpus paper whose journal resolved to an OpenAlex source,
#' matches it to a same-source, near-same-year work under a multi-signal guard
#' deliberately STRICTER than the API route's `title_sim >= 0.5` (the snapshot
#' join sees *every* work in a journal-year, and OpenAlex sometimes attaches a
#' foreign DOI to a work — a pediatric DOI on an APSR record, PLoS on Energy
#' Economics). Two stages:
#' \itemize{
#'   \item \strong{exact} (always): a hash equi-join on the sorted content-token
#'     SET — robust to word order/stopwords, near-linear, captures the bulk;
#'   \item \strong{fuzzy} (opt-in via `fuzzy = TRUE`): a token-blocked containment
#'     join over the residual, keeping shorter-in-longer matches (OpenAlex
#'     dropping a subtitle) while rejecting different papers that merely share
#'     stopwords/years.
#' }
#' Both stages require: the shorter title has >= `min_content_tokens` content
#' words (kills generic titles like "Introduction"/"Reply"); and the DOI's
#' registrant prefix covers >= `prefix_min_share` of that source's DOIs (kills
#' OpenAlex's foreign-DOI noise, data-driven).
#'
#' @param db_path Corpus DuckDB (read-only)
#' @param works_glob Local works parquet glob from `pull_openalex_works()`
#' @param srcmap Tibble (journal, src_id) from `resolve_container_sources()`
#' @param min_content_tokens Min content words in the shorter title (default 3)
#' @param prefix_min_share Min share of a source's DOIs a prefix must cover to
#'   be trusted (default 0.05)
#' @param year_tol Allowed |year difference| (default 1)
#' @param fuzzy Also run the token-blocked containment stage (default FALSE)
#' @param min_content_sim Min content-token containment for the fuzzy stage
#'   (default 0.9)
#' @return Tibble (Handle, doi, content_sim, match_type) — one row per handle
#' @export
snapshot_match_container_dois <- function(db_path, works_glob, srcmap,
                                          min_content_tokens = 3L, prefix_min_share = 0.05,
                                          year_tol = 1L, fuzzy = FALSE, min_content_sim = 0.9) {
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, sprintf("ATTACH '%s' AS corp (READ_ONLY);", db_path))
  duckdb::duckdb_register(con, "srcmap", dplyr::select(srcmap, journal, src_id))
  DBI::dbExecute(con, sprintf(
    "CREATE VIEW works AS SELECT * FROM read_parquet('%s')", works_glob))
  tol <- as.integer(year_tol); mct <- as.integer(min_content_tokens)

  # Per-source trusted DOI prefixes (data-driven), then the paper/work sides
  # with content key + tokens + prefix-ok flag, all materialized once.
  DBI::dbExecute(con, sprintf("CREATE TEMP TABLE prefixes AS
    WITH d AS (SELECT src_id, regexp_extract(doi,'10\\.[0-9]+',0) AS pfx
               FROM works WHERE doi IS NOT NULL),
         c AS (SELECT src_id, pfx, count(*) n,
                      sum(count(*)) OVER (PARTITION BY src_id) tot FROM d GROUP BY 1,2)
    SELECT src_id, list(pfx) AS allowed FROM c WHERE n::DOUBLE/tot >= %f GROUP BY src_id",
    prefix_min_share))
  DBI::dbExecute(con, sprintf("CREATE TEMP TABLE p AS
    SELECT a.Handle, a.year, m.src_id, %s AS ct, %s AS ckey, len(%s) AS n_ct
    FROM corp.articles a JOIN srcmap m ON a.journal = m.journal
    WHERE a.doi IS NULL AND a.title IS NOT NULL AND a.year IS NOT NULL AND m.src_id IS NOT NULL",
    oa_content_tokens_sql("a.title"), oa_content_key_sql("a.title"),
    oa_content_tokens_sql("a.title")))
  DBI::dbExecute(con, sprintf("CREATE TEMP TABLE w AS
    SELECT wk.doi, wk.year, wk.src_id, %s AS ct, %s AS ckey, len(%s) AS n_ct,
           coalesce(list_contains(px.allowed, regexp_extract(wk.doi,'10\\.[0-9]+',0)), FALSE) AS pfx_ok
    FROM works wk LEFT JOIN prefixes px ON wk.src_id = px.src_id
    WHERE wk.doi IS NOT NULL",
    oa_content_tokens_sql("wk.title"), oa_content_key_sql("wk.title"),
    oa_content_tokens_sql("wk.title")))

  # Exact stage: hash equi-join on (src_id, ckey), year range + guards.
  exact <- DBI::dbGetQuery(con, sprintf("
    WITH m AS (
      SELECT p.Handle, w.doi,
             row_number() OVER (PARTITION BY p.Handle ORDER BY w.doi) rn
      FROM p JOIN w ON p.src_id = w.src_id AND p.ckey = w.ckey AND abs(p.year - w.year) <= %d
      WHERE p.n_ct >= %d AND p.ckey <> '' AND w.pfx_ok)
    SELECT Handle, doi, 1.0 AS content_sim, 'exact' AS match_type FROM m WHERE rn = 1", tol, mct))

  out <- exact
  if (fuzzy) {
    # Token-blocked containment over residual papers: explode content tokens,
    # join on shared token within the same source/year, aggregate the overlap.
    duckdb::duckdb_register(con, "exact_handles", data.frame(Handle = unique(exact$Handle)))
    fz <- DBI::dbGetQuery(con, sprintf("
      WITH rp AS (SELECT * FROM p WHERE n_ct >= %d AND Handle NOT IN (SELECT Handle FROM exact_handles)),
      pt AS (SELECT Handle, src_id, year, n_ct, unnest(ct) AS tok FROM rp),
      wt AS (SELECT doi, src_id, year, n_ct AS w_n_ct, unnest(ct) AS tok FROM w WHERE pfx_ok),
      pr AS (
        SELECT pt.Handle, wt.doi,
               any_value(pt.n_ct) AS n_ct, any_value(wt.w_n_ct) AS w_n_ct,
               count(DISTINCT pt.tok) AS inter
        FROM pt JOIN wt ON pt.src_id = wt.src_id AND pt.tok = wt.tok
                       AND abs(pt.year - wt.year) <= %d
        GROUP BY pt.Handle, wt.doi),
      sc AS (SELECT Handle, doi, inter::DOUBLE / least(n_ct, w_n_ct) AS content_sim FROM pr),
      best AS (SELECT Handle, doi, content_sim,
                      row_number() OVER (PARTITION BY Handle ORDER BY content_sim DESC, doi) rn
               FROM sc WHERE content_sim >= %f)
      SELECT Handle, doi, content_sim, 'fuzzy' AS match_type FROM best WHERE rn = 1",
      mct, tol, min_content_sim))
    out <- dplyr::bind_rows(exact, fz)
  }

  out$doi <- normalize_doi(out$doi)
  tibble::as_tibble(out[!is.na(out$doi), ])
}

#' Resumable container DOI backfill from the OpenAlex snapshot
#'
#' Matches DOI-less container handles to the local works subset and merges the
#' hits into the `openalex_attempts.parquet` ledger (the same ledger the API
#' route would fill), so `finalize_doi_patch()` folds them under provenance
#' `openalex`. Idempotent: existing ledger handles are kept, new ones appended.
#'
#' @param db_path Corpus DuckDB. Defaults to config$db_folder/articles.duckdb
#' @param works_glob Local works parquet glob from `pull_openalex_works()`
#' @param srcmap Tibble (journal, src_id) from `resolve_container_sources()`
#' @param state_path Ledger parquet. Defaults to {pqt_patch}/openalex_attempts.parquet
#' @param ... Guard parameters forwarded to `snapshot_match_container_dois()`
#'   (`min_content_sim`, `min_raw_sim`, `min_content_tokens`, `prefix_min_share`,
#'   `year_tol`)
#' @return Tibble of this run's new hits (invisibly)
#' @export
container_backfill_snapshot <- function(db_path = NULL, works_glob, srcmap,
                                        state_path = NULL, ...) {
  config <- get_folder_config()
  if (is.null(db_path)) db_path <- file.path(config$db_folder, "articles.duckdb")
  if (is.null(state_path)) state_path <- file.path(config$pqt_patch_folder, "openalex_attempts.parquet")

  attempted <- read_doi_ledger(state_path, list(sim = numeric(), oa_type = character()))
  hits <- snapshot_match_container_dois(db_path, works_glob, srcmap, ...) |>
    dplyr::anti_join(attempted, by = "Handle") |>
    dplyr::transmute(Handle, doi, sim = content_sim, oa_type = "article", attempted_at = Sys.time())

  info("Snapshot container backfill: ", nrow(hits), " new DOIs matched")
  write_parquet_df(dplyr::bind_rows(attempted, hits), state_path)
  invisible(hits)
}
