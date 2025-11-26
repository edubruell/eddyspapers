.pool <- NULL

#' Setup API database connection pool
#'
#' Initializes a connection pool for the Plumber API with DuckDB VSS extension loaded.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param max_connections Maximum number of connections in pool
#' @return Pool object invisibly
#' @export
setup_api_pool <- function(db_path = NULL, max_connections = 5) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  pool <- pool::dbPool(
    drv = duckdb::duckdb(),
    dbdir = db_path,
    max_connections = max_connections
  )
  
  con <- pool::poolCheckout(pool)
  DBI::dbExecute(con, "LOAD vss;")
  DBI::dbExecute(con, "SET hnsw_enable_experimental_persistence=true;")
  DBI::dbExecute(con, "SET max_expression_depth TO 2000;")
  pool::poolReturn(con)
  
  .pool <<- pool
  
  invisible(pool)
}

#' Get current API connection pool
#'
#' Returns the initialized connection pool or errors if not set up.
#'
#' @return Pool object
#' @export
get_api_pool <- function() {
  if (is.null(.pool)) {
    stop("API pool not initialized. Call setup_api_pool() first.")
  }
  .pool
}

#' Close API connection pool
#'
#' Closes the connection pool and cleans up resources.
#'
#' @return NULL invisibly
#' @export
close_api_pool <- function() {
  if (!is.null(.pool)) {
    pool::poolClose(.pool)
    .pool <<- NULL
  }
  invisible(NULL)
}

#' Semantic search papers with filters
#'
#' Performs vector similarity search on paper abstracts with optional filters.
#'
#' @param query Text query (question or abstract)
#' @param max_k Maximum number of results to return
#' @param min_year Minimum publication year filter
#' @param journal_filter Comma-separated category codes
#' @param journal_name Comma-separated journal names (substring matching)
#' @param title_keyword Keyword filter for titles
#' @param author_keyword Keyword filter for authors
#' @param pool Database pool. Defaults to get_api_pool()
#' @param model Ollama embedding model name
#' @return Data frame with search results and similarity scores
#' @export
semantic_search <- function(query,
                            max_k = 100,
                            min_year = NULL,
                            journal_filter = NULL,
                            journal_name = NULL,
                            title_keyword = NULL,
                            author_keyword = NULL,
                            pool = NULL,
                            model = "mxbai-embed-large") {
  
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  safe_int <- function(x) {
    if (is.null(x) || length(x) == 0 || is.na(x) || x == "") return(NULL)
    as.integer(x)
  }
  
  min_year <- safe_int(min_year)
  max_k <- safe_int(max_k)
  
  query_vec <- unlist(
    tidyllm::ollama_embedding(query, .model = model)$embeddings
  )
  
  con <- pool::poolCheckout(pool)
  
  filters <- c()
  
  if (!is.null(min_year)) {
    filters <- c(filters, sprintf("a.year >= %d", min_year))
  }
  
  if (!is.null(journal_filter) && nchar(journal_filter) > 0) {
    cats <- stringr::str_split(journal_filter, ",", simplify = FALSE)[[1]] |> 
      stringr::str_trim()
    cats_sql <- paste(shQuote(cats), collapse = ",")
    filters <- c(filters, sprintf("a.category IN (%s)", cats_sql))
  }
  
  if (!is.null(journal_name) && nchar(journal_name) > 0) {
    journals <- stringr::str_split(journal_name, ",", simplify = FALSE)[[1]] |> 
      stringr::str_trim()
    
    journal_clauses <- sprintf(
      "LOWER(a.journal) LIKE LOWER('%%%s%%')",
      journals
    )
    
    filters <- c(filters, paste0("(", paste(journal_clauses, collapse = " OR "), ")"))
  }
  
  if (!is.null(title_keyword) && nchar(title_keyword) > 0) {
    filters <- c(filters,
                 sprintf("LOWER(a.title) LIKE LOWER('%%%s%%')", title_keyword))
  }
  
  if (!is.null(author_keyword) && nchar(author_keyword) > 0) {
    filters <- c(filters,
                 sprintf("LOWER(a.authors) LIKE LOWER('%%%s%%')", author_keyword))
  }
  
  where_clause <- if (length(filters)) {
    paste("WHERE", paste(filters, collapse = " AND "))
  } else ""
  
  sql <- sprintf("
    SELECT a.title, a.year, a.authors, a.journal, a.category, a.url,
           a.bib_tex, a.abstract,
           array_cosine_distance(a.embeddings, ?::FLOAT[1024]) AS similarity
    FROM articles a
    %s
    ORDER BY similarity ASC
    LIMIT ?
  ", where_clause)
  
  DBI::dbExecute(con, "LOAD vss;")
  stmt <- DBI::dbSendQuery(con, sql)
  DBI::dbBind(stmt, list(list(query_vec), max_k))
  
  res <- DBI::dbFetch(stmt)
  DBI::dbClearResult(stmt)
  pool::poolReturn(con)
  
  res
}

#' Get journal article counts
#'
#' Returns count of articles per journal.
#'
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Tibble with journal and count columns
#' @export
get_journal_stats <- function(pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  res <- DBI::dbGetQuery(con, 
    "SELECT journal, COUNT(*) as n FROM articles GROUP BY journal ORDER BY journal"
  ) |> tibble::as_tibble()
  pool::poolReturn(con)
  res
}

#' Get total article count
#'
#' Returns the total number of articles in the database.
#'
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Integer count
#' @export
get_total_articles <- function(pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  res <- DBI::dbGetQuery(con, "SELECT COUNT(*) as n FROM articles")
  pool::poolReturn(con)
  res$n
}

#' Get category article counts
#'
#' Returns count of articles per category, ordered by count.
#'
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Tibble with category and count columns
#' @export
get_category_stats <- function(pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  res <- DBI::dbGetQuery(con, 
    "SELECT category, COUNT(*) as n FROM articles GROUP BY category ORDER BY n DESC"
  ) |> tibble::as_tibble()
  pool::poolReturn(con)
  res
}

#' Get database last update date
#'
#' Returns the last modification date of the database file.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @return Date string in YYYY-MM-DD format
#' @export
get_last_updated <- function(db_path = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  db_age <- file.info(db_path)$mtime |> 
    as.character() |>
    stringr::str_extract("\\d{4}-\\d{2}-\\d{2}")
  db_age
}

#' Run the Plumber API server
#'
#' Starts the Plumber API server with initialized connection pool.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param max_connections Maximum connections in pool
#' @param host Host address to bind to
#' @param port Port number to listen on
#' @return Does not return (starts server)
#' @export
run_plumber_api <- function(db_path = NULL, 
                            max_connections = 5,
                            host = "0.0.0.0",
                            port = 8000) {
  
  setup_api_pool(db_path, max_connections)
  
  api_file <- system.file("plumber/api.R", package = "eddyspapersbackend")
  
  if (!file.exists(api_file)) {
    stop("Plumber API file not found: ", api_file)
  }
  
  pr <- plumber::plumb(api_file)
  
  message("Starting API on ", host, ":", port)
  pr$run(host = host, port = port)
}
