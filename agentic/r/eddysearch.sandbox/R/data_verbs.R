paper_url <- function(handle, url = NULL) {
  if (!is.null(url) && nchar(url) > 0) return(url)
  path <- sub("^repec:", "", handle)
  path <- gsub(":", "/", path)
  paste0("https://ideas.repec.org/", path)
}

semantic_search <- function(query, max_k = 30, min_year = NULL, journal_filter = NULL, journal_name = NULL) {
  t0 <- Sys.time()
  emit_progress(paste0("semantic_search: ", stringr::str_trunc(query, 60)))

  con <- .sandbox_state$con

  emb_result <- tidyllm::ollama_embedding(query, .model = "mxbai-embed-large")
  vec <- unlist(emb_result$embeddings)

  filters <- character(0)

  if (!is.null(min_year)) {
    filters <- c(filters, sprintf("a.year >= %d", as.integer(min_year)))
  }

  if (!is.null(journal_filter) && length(journal_filter) > 0) {
    cats_sql <- paste(shQuote(journal_filter), collapse = ", ")
    filters <- c(filters, sprintf("a.category IN (%s)", cats_sql))
  }

  if (!is.null(journal_name)) {
    filters <- c(filters, sprintf("LOWER(a.journal) LIKE LOWER('%%%s%%')", journal_name))
  }

  where_clause <- if (length(filters) > 0) {
    paste("WHERE", paste(filters, collapse = " AND "))
  } else {
    ""
  }

  sql <- sprintf(
    "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url,
            a.bib_tex, a.abstract,
            array_cosine_distance(a.embeddings, ?::FLOAT[1024]) AS similarity
     FROM articles a
     %s
     ORDER BY similarity ASC
     LIMIT ?",
    where_clause
  )

  rs <- DBI::dbSendQuery(con, sql)
  DBI::dbBind(rs, list(list(vec), max_k))
  result <- DBI::dbFetch(rs)
  DBI::dbClearResult(rs)

  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
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

  sql <- "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url, a.abstract, a.bib_tex
          FROM cit_internal ci
          JOIN articles a ON ci.cited = a.Handle
          WHERE ci.citing = ?
          LIMIT ?"

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, limit))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

citedby <- function(handle, limit = 50) {
  t0 <- Sys.time()
  emit_progress(paste0("citedby: ", stringr::str_trunc(handle, 60)))

  sql <- "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url, a.abstract, a.bib_tex
          FROM cit_internal ci
          JOIN articles a ON ci.citing = a.Handle
          WHERE ci.cited = ?
          LIMIT ?"

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, limit))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

handle_stats <- function(handles) {
  t0 <- Sys.time()
  emit_progress("handle_stats")

  placeholders <- paste(rep("?", length(handles)), collapse = ", ")
  sql <- paste0("SELECT * FROM handle_stats WHERE handle IN (", placeholders, ")")

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = as.list(handles))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

versions <- function(handle) {
  t0 <- Sys.time()
  emit_progress(paste0("versions: ", stringr::str_trunc(handle, 60)))

  sql <- "SELECT * FROM versions WHERE canonical_handle = ? OR handle = ?"

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(handle, handle))
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
