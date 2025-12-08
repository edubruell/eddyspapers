.pool_env <- new.env(parent = emptyenv())
.pool_env$pool <- NULL

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
  DBI::dbExecute(con, "INSTALL json;")
  DBI::dbExecute(con, "LOAD json;")
  pool::poolReturn(con)
  
  .pool_env$pool <- pool
  
  invisible(pool)
}

#' Get current API connection pool
#'
#' Returns the initialized connection pool or errors if not set up.
#'
#' @return Pool object
#' @export
get_api_pool <- function() {
  pool <- .pool_env$pool
  if (is.null(pool)) {
    stop("API pool not initialized. Call setup_api_pool() first.")
  }
  pool
}

#' Close API connection pool
#'
#' Closes the connection pool and cleans up resources.
#'
#' @return NULL invisibly
#' @export
close_api_pool <- function() {
  if (!is.null(.pool_env$pool)) {
    pool::poolClose(.pool_env$pool)
    .pool_env$pool <- NULL
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
    SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url,
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

#' Ensure saved searches table exists
#'
#' Creates the saved_searches table if it doesn't exist.
#'
#' @param pool Database pool. Defaults to get_api_pool()
#' @return NULL invisibly
#' @export
ensure_saved_searches_table <- function(pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS saved_searches (
      hash VARCHAR PRIMARY KEY,
      query TEXT NOT NULL,
      max_k INTEGER,
      min_year INTEGER,
      journal_filter TEXT,
      journal_name TEXT,
      title_keyword TEXT,
      author_keyword TEXT,
      results JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  ")
  
  pool::poolReturn(con)
  invisible(NULL)
}

#' Generate hash for search parameters
#'
#' Creates a consistent hash from search parameters using digest package.
#'
#' @param query Text query
#' @param max_k Maximum results
#' @param min_year Minimum year
#' @param journal_filter Category filter
#' @param journal_name Journal name filter
#' @param title_keyword Title keyword filter
#' @param author_keyword Author keyword filter
#' @return 8-character hash string
#' @export
generate_search_hash <- function(query,
                                 max_k = 100,
                                 min_year = NULL,
                                 journal_filter = NULL,
                                 journal_name = NULL,
                                 title_keyword = NULL,
                                 author_keyword = NULL) {
  
  params <- list(
    query = query,
    max_k = max_k,
    min_year = min_year,
    journal_filter = journal_filter,
    journal_name = journal_name,
    title_keyword = title_keyword,
    author_keyword = author_keyword
  )
  
  hash_full <- digest::digest(params, algo = "xxhash64")
  substr(hash_full, 1, 8)
}

#' Save search query and results
#'
#' Saves a search query with its parameters and results to the database using a hash identifier.
#'
#' @param query Text query
#' @param results Search results data frame
#' @param max_k Maximum results
#' @param min_year Minimum year
#' @param journal_filter Category filter
#' @param journal_name Journal name filter
#' @param title_keyword Title keyword filter
#' @param author_keyword Author keyword filter
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Hash string for the saved search
#' @export
save_search <- function(query,
                       results,
                       max_k = 100,
                       min_year = NULL,
                       journal_filter = NULL,
                       journal_name = NULL,
                       title_keyword = NULL,
                       author_keyword = NULL,
                       pool = NULL) {
  
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  ensure_saved_searches_table(pool)
  
  hash <- generate_search_hash(
    query = query,
    max_k = max_k,
    min_year = min_year,
    journal_filter = journal_filter,
    journal_name = journal_name,
    title_keyword = title_keyword,
    author_keyword = author_keyword
  )
  
  con <- pool::poolCheckout(pool)
  
  existing <- DBI::dbGetQuery(
    con, 
    "SELECT hash FROM saved_searches WHERE hash = ?",
    params = list(hash)
  )
  
  norm <- function(x) if (is.null(x)) NA else x
  
  if (nrow(existing) == 0) {
    results_json <- jsonlite::toJSON(results, auto_unbox = TRUE)
    
    DBI::dbExecute(con, "
  INSERT INTO saved_searches 
    (hash, query, max_k, min_year, journal_filter, journal_name, 
     title_keyword, author_keyword, results)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
",
                   params = list(
                     hash,
                     query,
                     max_k,
                     norm(min_year),
                     norm(journal_filter),
                     norm(journal_name),
                     norm(title_keyword),
                     norm(author_keyword),
                     as.character(results_json)
                   ))
    
  }
  
  pool::poolReturn(con)
  hash
}


#' Ensure search logs table exists
#'
#' Creates the search_logs table if it doesn't exist.
#'
#' @param pool Database pool. Defaults to get_api_pool()
#' @return NULL invisibly
#' @export
ensure_search_logs_table <- function(pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS search_logs (
      search_id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR,
      query_hash VARCHAR(8),
      result_count INTEGER,
      top3_handles VARCHAR[],
      has_year_filter BOOLEAN,
      has_journal_filter BOOLEAN,
      has_journal_name_filter BOOLEAN,
      has_title_keyword BOOLEAN,
      has_author_keyword BOOLEAN,
      response_time_ms INTEGER
    )
  ")
  
  DBI::dbExecute(con, "
    CREATE SEQUENCE IF NOT EXISTS search_logs_seq START 1
  ")
  
  pool::poolReturn(con)
  invisible(NULL)
}

#' Log search query
#'
#' Logs search query with IP, filters, and top result handles.
#'
#' @param ip Client IP address
#' @param query_hash Hash of the query
#' @param result_count Number of results returned
#' @param top3_handles Vector of top 3 RePEc handles
#' @param filter_flags Named list of filter presence flags
#' @param response_time_ms Response time in milliseconds
#' @param pool Database pool. Defaults to get_api_pool()
#' @return Search log ID
#' @export
log_search <- function(ip,
                      query_hash,
                      result_count,
                      top3_handles = NULL,
                      filter_flags = NULL,
                      response_time_ms = NULL,
                      pool = NULL) {
  
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  ensure_search_logs_table(pool)
  
  con <- pool::poolCheckout(pool)
  
  search_id <- DBI::dbGetQuery(con, "SELECT nextval('search_logs_seq') as id")$id
  
  has_year <- if (!is.null(filter_flags)) filter_flags$has_year else FALSE
  has_journal_filter <- if (!is.null(filter_flags)) filter_flags$has_journal_filter else FALSE
  has_journal_name <- if (!is.null(filter_flags)) filter_flags$has_journal_name else FALSE
  has_title_keyword <- if (!is.null(filter_flags)) filter_flags$has_title_keyword else FALSE
  has_author_keyword <- if (!is.null(filter_flags)) filter_flags$has_author_keyword else FALSE
  
  handles_list <- if (!is.null(top3_handles) && length(top3_handles) > 0) {
    list(top3_handles[1:min(3, length(top3_handles))])
  } else {
    list(character(0))
  }
  
  DBI::dbExecute(con, "
    INSERT INTO search_logs 
      (search_id, ip, query_hash, result_count, top3_handles,
       has_year_filter, has_journal_filter, has_journal_name_filter,
       has_title_keyword, has_author_keyword, response_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ", params = list(
    search_id, ip, query_hash, result_count, handles_list,
    has_year, has_journal_filter, has_journal_name,
    has_title_keyword, has_author_keyword, response_time_ms
  ))
  
  pool::poolReturn(con)
  search_id
}

#' Get search log statistics
#'
#' Returns aggregated statistics from search logs.
#'
#' @param days Number of days to include (default 30)
#' @param pool Database pool. Defaults to get_api_pool()
#' @return List with various statistics
#' @export
get_search_stats <- function(days = 30, pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  
  cutoff <- format(Sys.time() - days * 86400, "%Y-%m-%d %H:%M:%S")
  
  total_searches <- DBI::dbGetQuery(con, sprintf("
    SELECT COUNT(*) as total
    FROM search_logs
    WHERE timestamp >= '%s'
  ", cutoff))$total
  
  avg_results <- DBI::dbGetQuery(con, sprintf("
    SELECT AVG(result_count) as avg_results
    FROM search_logs
    WHERE timestamp >= '%s'
  ", cutoff))$avg_results
  
  avg_response <- DBI::dbGetQuery(con, sprintf("
    SELECT AVG(response_time_ms) as avg_ms
    FROM search_logs
    WHERE timestamp >= '%s' AND response_time_ms IS NOT NULL
  ", cutoff))$avg_ms
  
  filter_usage <- DBI::dbGetQuery(con, sprintf("
    SELECT 
      SUM(CASE WHEN has_year_filter THEN 1 ELSE 0 END) as year_filters,
      SUM(CASE WHEN has_journal_filter THEN 1 ELSE 0 END) as journal_filters,
      SUM(CASE WHEN has_journal_name_filter THEN 1 ELSE 0 END) as journal_name_filters,
      SUM(CASE WHEN has_title_keyword THEN 1 ELSE 0 END) as title_keyword_filters,
      SUM(CASE WHEN has_author_keyword THEN 1 ELSE 0 END) as author_keyword_filters
    FROM search_logs
    WHERE timestamp >= '%s'
  ", cutoff))
  
  pool::poolReturn(con)
  
  list(
    days = days,
    total_searches = total_searches,
    avg_results = avg_results,
    avg_response_ms = avg_response,
    filter_usage = filter_usage
  )
}

#' Get a saved search by hash
#'
#' Retrieves a saved search and its results.
#'
#' @param hash 8 character search hash
#' @param pool Database pool
#' @return List or NULL if not found
#' @export
get_saved_search <- function(hash, pool = NULL) {
  if (is.null(pool)) {
    pool <- get_api_pool()
  }
  
  con <- pool::poolCheckout(pool)
  
  res <- DBI::dbGetQuery(con, "
    SELECT 
      hash, query, max_k, min_year, journal_filter, journal_name,
      title_keyword, author_keyword, results, created_at
    FROM saved_searches
    WHERE hash = ?
  ", params = list(hash))
  
  pool::poolReturn(con)
  
  if (nrow(res) == 0) return(NULL)
  
  # parse JSON for the first (and only) row
  results_df <- jsonlite::fromJSON(res$results[[1]])
  
  # build a clean list
  list(
    hash           = res$hash[[1]],
    query          = res$query[[1]],
    max_k          = res$max_k[[1]],
    min_year       = res$min_year[[1]],
    journal_filter = res$journal_filter[[1]],
    journal_name   = res$journal_name[[1]],
    title_keyword  = res$title_keyword[[1]],
    author_keyword = res$author_keyword[[1]],
    created_at     = res$created_at[[1]],
    results        = results_df
  )
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
