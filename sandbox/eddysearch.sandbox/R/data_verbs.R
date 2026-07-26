paper_url <- function(handle, url = NULL) {
  # url may arrive as NA (DB null read into R) — guard before nchar() so a null
  # URL on any single paper doesn't abort the whole script.
  if (!is.null(url) && length(url) == 1 && !is.na(url) && nzchar(url)) return(url)
  path <- sub("^repec:", "", handle)
  path <- gsub(":", "/", path)
  paste0("https://ideas.repec.org/", path)
}

semantic_search <- function(query, max_k = 30, min_year = NULL, journal_filter = NULL, journal_name = NULL, jel = NULL) {
  t0 <- Sys.time()
  emit_progress(paste0("semantic_search: ", stringr::str_trunc(query, 60)))

  con <- .sandbox_state$con

  emb_result <- tidyllm::ollama_embedding(query, .model = "mxbai-embed-large")
  vec <- unlist(emb_result$embeddings)

  # The HNSW index only accelerates a plain `ORDER BY <distance> LIMIT k` scan with
  # no WHERE clause — adding one (year/category/journal filters) makes DuckDB's
  # planner fall back to a full sequential scan of ~479k embedding rows, which is
  # what was blowing the agentic sandbox's timeout on filtered calls (seconds vs.
  # 50s+ per call; see api/scripts/spike_vss.ts). So we always run the
  # index-accelerated unfiltered top-k scan over a generous candidate pool, then
  # apply the filters in R — same result semantics, at the cost of not seeing a
  # filter-matching paper ranked below the candidate pool.
  candidate_k <- max(as.integer(max_k) * 15L, 300L)

  sql <- "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url,
                 a.doi, a.bib_tex, a.abstract,
                 array_cosine_distance(a.embeddings, ?::FLOAT[1024]) AS similarity
          FROM articles a
          ORDER BY similarity ASC
          LIMIT ?"

  rs <- DBI::dbSendQuery(con, sql)
  DBI::dbBind(rs, list(list(vec), candidate_k))
  candidates <- DBI::dbFetch(rs)
  DBI::dbClearResult(rs)

  candidates <- dplyr::as_tibble(candidates)

  if (!is.null(min_year)) {
    candidates <- dplyr::filter(candidates, year >= as.integer(min_year))
  }
  if (!is.null(journal_filter) && length(journal_filter) > 0) {
    candidates <- dplyr::filter(candidates, category %in% journal_filter)
  }
  if (!is.null(journal_name)) {
    candidates <- dplyr::filter(candidates, grepl(tolower(journal_name), tolower(journal), fixed = TRUE))
  }
  if (!is.null(jel) && length(jel) > 0) {
    candidates <- filter_by_jel(con, candidates, jel)
  }

  result <- dplyr::slice_head(candidates, n = max_k)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

# JEL post-filter for the candidate-pool pattern: one lookup against article_jel
# for the candidate handles, then keep rows matching any code/prefix. Runs after
# the index-accelerated scan so the HNSW fast path is preserved. article_jel
# stores handles lowercase. Coverage is ~55% of the corpus — papers without any
# JEL rows are dropped by this filter even though their codes are merely unknown.
filter_by_jel <- function(con, candidates, jel) {
  codes <- toupper(trimws(jel))
  codes <- codes[grepl("^[A-Z][0-9]{0,2}$", codes)]
  # All-invalid input errors instead of silently returning zero rows — a script
  # would read "0 results" as "no papers in this area", which is the one wrong
  # conclusion an invalid filter must never produce.
  if (length(codes) == 0) {
    stop("jel filter contains no valid JEL codes (expected e.g. 'J31' or 'J3'): ",
         paste(jel, collapse = ", "))
  }
  if (nrow(candidates) == 0) return(candidates)

  placeholders <- paste(rep("?", nrow(candidates)), collapse = ", ")
  sql <- paste0(
    "SELECT DISTINCT handle FROM article_jel WHERE handle IN (", placeholders, ") AND (",
    paste(rep("jel_code LIKE ?", length(codes)), collapse = " OR "), ")"
  )
  matched <- DBI::dbGetQuery(
    con, sql,
    params = c(as.list(tolower(candidates$Handle)), as.list(paste0(codes, "%")))
  )$handle

  dplyr::filter(candidates, tolower(Handle) %in% matched)
}

sql_query <- function(sql, params = list()) {
  t0 <- Sys.time()
  emit_progress(paste0("SQL query: ", stringr::str_trunc(sql, 60)))

  validate_sql(sql, .sandbox_state$con)
  final_sql <- inject_limit(sql, con = .sandbox_state$con)

  result <- DBI::dbGetQuery(.sandbox_state$con, final_sql, params = params)
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

cites <- function(handle, limit = 50) {
  t0 <- Sys.time()
  emit_progress(paste0("cites: ", stringr::str_trunc(handle, 60)))

  # cit_internal stores lowercase handles; articles.Handle is mixed case. Joining
  # without LOWER() returns zero rows for every call (found 2026-07-10 while
  # building the Phase 1 test fixture).
  sql <- "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url, a.doi, a.abstract, a.bib_tex
          FROM cit_internal ci
          JOIN articles a ON ci.cited = LOWER(a.Handle)
          WHERE ci.citing = LOWER(?)
          LIMIT ?"

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, limit))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

citedby <- function(handle, limit = 50) {
  t0 <- Sys.time()
  emit_progress(paste0("citedby: ", stringr::str_trunc(handle, 60)))

  sql <- "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url, a.doi, a.abstract, a.bib_tex
          FROM cit_internal ci
          JOIN articles a ON ci.citing = LOWER(a.Handle)
          WHERE ci.cited = LOWER(?)
          LIMIT ?"

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, limit))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

handle_stats <- function(handles) {
  t0 <- Sys.time()
  emit_progress("handle_stats")

  # handle_stats.handle is stored lowercase (like cit_internal) — lowercase the
  # caller's handles so articles$Handle drops in directly (same bug class as the
  # cites/citedby LOWER fix, 2026-07-10).
  placeholders <- paste(rep("?", length(handles)), collapse = ", ")
  sql <- paste0("SELECT * FROM handle_stats WHERE handle IN (", placeholders, ")")

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = as.list(tolower(handles)))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

versions <- function(handle) {
  t0 <- Sys.time()
  emit_progress(paste0("versions: ", stringr::str_trunc(handle, 60)))

  # Version relationships live in version_links(source, target, type) as directed edges.
  # Return one row per *other* endpoint of any edge touching `handle`, joined to article
  # metadata so the result chains directly into emit_section/handle_stats/bib_for. The `Handle`
  # column is the linked paper (the queried handle is never returned as its own version).
  sql <- "
    WITH links AS (
      SELECT
        CASE WHEN LOWER(source) = LOWER(?) THEN target ELSE source END AS related,
        type
      FROM version_links
      WHERE LOWER(source) = LOWER(?) OR LOWER(target) = LOWER(?)
    )
    SELECT
      COALESCE(a.Handle, l.related) AS Handle,
      l.type AS type,
      a.title, a.year, a.authors, a.journal, a.category, a.url, a.doi, a.bib_tex, a.abstract
    FROM links l
    LEFT JOIN articles a ON LOWER(a.Handle) = LOWER(l.related)
  "

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, handle, handle))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

bib_for <- function(handles) {
  t0 <- Sys.time()
  emit_progress(paste0("bib_for: ", stringr::str_trunc(paste(handles, collapse = ", "), 60)))

  placeholders <- paste(rep("?", length(handles)), collapse = ", ")
  sql <- paste0("SELECT Handle, bib_tex FROM articles WHERE Handle IN (", placeholders, ")")

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = as.list(handles))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

journals <- function() {
  dplyr::as_tibble(DBI::dbGetQuery(.sandbox_state$con, "SELECT * FROM journals"))
}

categories <- function() {
  dplyr::as_tibble(DBI::dbGetQuery(
    .sandbox_state$con,
    "SELECT DISTINCT category FROM articles WHERE category IS NOT NULL ORDER BY category"
  ))
}
