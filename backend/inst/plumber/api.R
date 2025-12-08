#* @apiTitle Semantic Paper Search API
#* @apiDescription Vector search with deep filtering

#* Search papers semantically with filters
#* @post /search
#* @param query Text query (embedded)
#* @param max_k Max results
#* @param min_year Minimum year
#* @param journal_filter Category filter
#* @param journal_name Comma-separated list of journal names or substrings
#* @param title_keyword Keyword in title
#* @param author_keyword Keyword in authors
function(req,
         query,
         max_k = 100,
         min_year = NULL,
         journal_filter = NULL,
         journal_name = NULL,
         title_keyword = NULL,
         author_keyword = NULL) {
  
  start_time <- Sys.time()
  
  res <- semantic_search(
    query          = query,
    max_k          = max_k,
    min_year       = min_year,
    journal_filter = journal_filter,
    journal_name   = journal_name,
    title_keyword  = title_keyword,
    author_keyword = author_keyword
  )
  
  res$similarity_score <- round(1 - res$similarity, 5)
  res <- res |> dplyr::arrange(dplyr::desc(similarity_score))
  
  response_time_ms <- as.numeric(difftime(Sys.time(), start_time, units = "secs")) * 1000
  
  query_hash <- generate_search_hash(
    query          = query,
    max_k          = max_k,
    min_year       = min_year,
    journal_filter = journal_filter,
    journal_name   = journal_name,
    title_keyword  = title_keyword,
    author_keyword = author_keyword
  )
  
  top3_handles <- if (nrow(res) > 0) res$Handle[1:min(3, nrow(res))] else NULL
  
  filter_flags <- list(
    has_year = !is.null(min_year),
    has_journal_filter = !is.null(journal_filter) && nchar(journal_filter) > 0,
    has_journal_name = !is.null(journal_name) && nchar(journal_name) > 0,
    has_title_keyword = !is.null(title_keyword) && nchar(title_keyword) > 0,
    has_author_keyword = !is.null(author_keyword) && nchar(author_keyword) > 0
  )
  
  log_search(
    ip                = req$REMOTE_ADDR,
    query_hash        = query_hash,
    result_count      = nrow(res),
    top3_handles      = top3_handles,
    filter_flags      = filter_flags,
    response_time_ms  = response_time_ms
  )
  
  res
}


#* Search papers and save with hash
#* @post /search/save
#* @param query Text query (embedded)
#* @param max_k Max results
#* @param min_year Minimum year
#* @param journal_filter Category filter
#* @param journal_name Comma-separated list of journal names or substrings
#* @param title_keyword Keyword in title
#* @param author_keyword Keyword in authors
function(req,
         query,
         max_k = 100,
         min_year = NULL,
         journal_filter = NULL,
         journal_name = NULL,
         title_keyword = NULL,
         author_keyword = NULL) {
  
  start_time <- Sys.time()
  
  res <- semantic_search(
    query          = query,
    max_k          = max_k,
    min_year       = min_year,
    journal_filter = journal_filter,
    journal_name   = journal_name,
    title_keyword  = title_keyword,
    author_keyword = author_keyword
  )
  
  res$similarity_score <- round(1 - res$similarity, 5)
  res <- res |> 
    dplyr::arrange(dplyr::desc(similarity_score))
  
  hash <- save_search(
    query          = query,
    results        = res,
    max_k          = max_k,
    min_year       = min_year,
    journal_filter = journal_filter,
    journal_name   = journal_name,
    title_keyword  = title_keyword,
    author_keyword = author_keyword
  )
  
  response_time_ms <- as.numeric(difftime(Sys.time(), start_time, units = "secs")) * 1000
  
  top3_handles <- if (nrow(res) > 0) res$Handle[1:min(3, nrow(res))] else NULL
  
  filter_flags <- list(
    has_year = !is.null(min_year),
    has_journal_filter = !is.null(journal_filter) && nchar(journal_filter) > 0,
    has_journal_name = !is.null(journal_name) && nchar(journal_name) > 0,
    has_title_keyword = !is.null(title_keyword) && nchar(title_keyword) > 0,
    has_author_keyword = !is.null(author_keyword) && nchar(author_keyword) > 0
  )
  
  log_search(
    ip                = req$REMOTE_ADDR,
    query_hash        = hash,
    result_count      = nrow(res),
    top3_handles      = top3_handles,
    filter_flags      = filter_flags,
    response_time_ms  = response_time_ms
  )
  
  list(
    hash = hash,
    results = res
  )
}

#* Get search log statistics
#* @get /stats/searches
#* @param days Number of days to include (default 30)
function(days = 30) {
  get_search_stats(days = as.integer(days))
}


#* Retrieve saved search by hash
#* @get /search/<hash>
function(hash) {
  saved <- get_saved_search(hash)
  
  if (is.null(saved)) {
    res <- list(error = "Search not found")
    res$status <- 404
    return(res)
  }
  
  saved$results$similarity_score <- round(1 - saved$results$similarity, 5)
  saved$results <- saved$results |> dplyr::arrange(dplyr::desc(similarity_score))
  
  saved
}

#* Get journal entry counts
#* @get /stats/journals
function() {
  get_journal_stats()
}

#* Get total article count
#* @get /stats/total
function() {
  list(total_articles = get_total_articles())
}

#* Get category counts
#* @get /stats/categories
function() {
  get_category_stats()
}

#* Get last database update date
#* @get /stats/last_updated
function() {
  list(last_updated = get_last_updated())
}
