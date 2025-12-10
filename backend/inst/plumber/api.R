#* @filter cors
function(req, res) {
  res$setHeader("Access-Control-Allow-Origin", "*")
  res$setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res$setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  
  if (req$REQUEST_METHOD == "OPTIONS") {
    res$status <- 200
    return(list())
  }
  
  plumber::forward()
}


#* @apiTitle Semantic Paper Search API
#* @apiDescription Vector search with deep filtering

#* @schema PaperResult
#* @property Handle string
#* @property title string
#* @property year integer
#* @property authors string
#* @property journal string
#* @property category string
#* @property url string
#* @property bib_tex string
#* @property abstract string
#* @property similarity number Cosine distance (lower is closer)
#* @property similarity_score number Normalized similarity score
NULL

#* Search papers semantically with filters
#* @post /search
#* @serializer json
#* @apiResponse 200 {array} PaperResult List of matching papers
#* @param query:string Text query to embed
#* @param max_k:number Maximum number of results
#* @param min_year:number Minimum publication year
#* @param journal_filter:string Category filter (comma separated)
#* @param journal_name:string Journal name filter (comma separated substrings)
#* @param title_keyword:string Keyword filter for titles
#* @param author_keyword:string Keyword filter for authors
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


#* @schema SavedSearchResponse
#* @property hash string Unique identifier for this saved search
#* @property query string
#* @property max_k integer
#* @property min_year integer
#* @property journal_filter string
#* @property journal_name string
#* @property title_keyword string
#* @property author_keyword string
#* @property created_at string Timestamp of storage
#* @property results array[PaperResult]  search results
NULL

#* Search papers and save with hash
#* @post /search/save
#* @serializer json
#* @apiResponse 200 {object} SavedSearchResponse Saved query and results
#* @param query:string Text query
#* @param max_k:number Maximum number of results
#* @param min_year:number Minimum publication year
#* @param journal_filter:string Comma separated category codes
#* @param journal_name:string Comma separated journal names or substrings
#* @param title_keyword:string Keyword filter for titles
#* @param author_keyword:string Keyword filter for authors
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

#* @schema SearchStats
#* @property days integer Number of days included
#* @property total_searches integer Total number of searches
#* @property avg_results number Average number of results returned
#* @property avg_response_ms number Average response time in milliseconds
#* @property filter_usage object Breakdown of filter usage counts
#* @property filter_usage.year_filters integer
#* @property filter_usage.journal_filters integer
#* @property filter_usage.journal_name_filters integer
#* @property filter_usage.title_keyword_filters integer
#* @property filter_usage.author_keyword_filters integer
NULL

#* Get search log statistics
#* @get /stats/searches
#* @serializer json
#* @apiResponse 200 {object} SearchStats Aggregated search statistics
#* @param days:number Number of days to include
function(days = 30) {
  get_search_stats(days = as.integer(days))
}


#* @schema SavedSearch
#* @property hash string
#* @property query string
#* @property max_k integer
#* @property min_year integer
#* @property journal_filter string
#* @property journal_name string
#* @property title_keyword string
#* @property author_keyword string
#* @property created_at string
#* @property results array[PaperResult]
NULL

#* @schema NotFoundError
#* @property error string Error message
NULL

#* Retrieve saved search by hash
#* @get /search/<hash>
#* @serializer json
#* @apiResponse 200 {object} SavedSearch Retrieved search
#* @apiResponse 404 {object} NotFoundError Search not found
#* @param hash:string Search hash (8 characters)
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

#* @schema JournalCount
#* @property journal string Journal name
#* @property n integer Number of articles in this journal
NULL

#* Get journal entry counts
#* @get /stats/journals
#* @serializer json
#* @apiResponse 200 {array} JournalCount List of journals with article counts
function() {
  get_journal_stats()
}

#* @schema TotalArticles
#* @property total_articles integer Total number of articles
NULL

#* Get total article count
#* @get /stats/total
#* @serializer json
#* @apiResponse 200 {object} TotalArticles Total article count
function() {
  list(total_articles = get_total_articles())
}

#* @schema CategoryCount
#* @property category string Category code
#* @property n integer Number of articles in this category
NULL

#* Get category counts
#* @get /stats/categories
#* @serializer json
#* @apiResponse 200 {array} CategoryCount List of categories with article counts
function() {
  get_category_stats()
}

#* @schema LastUpdated
#* @property last_updated string Date of last database update (YYYY-MM-DD)
NULL

#* Get last database update date
#* @get /stats/last_updated
#* @serializer json
#* @apiResponse 200 {object} LastUpdated Last update date of the database
function() {
  list(last_updated = get_last_updated())
}

#* @schema VersionLink
#* @property source string Original handle
#* @property target string Linked version handle
#* @property type string Link type (for example redif-paper, redif-series)
#* @property year integer Publication year of the target version
#* @property title string Title of the target version
#* @property authors string Authors of the target version
#* @property journal string Journal or series name
#* @property is_series boolean Indicator for series entries
#* @property url string URL to the linked version
NULL

#* Get version links for a given RePEc handle
#* @get /versions
#* @serializer json
#* @apiResponse 200 {array} VersionLink List of version links
#* @param handle:string RePEc handle to query
function(handle) {
  get_version_links(source_handle = handle)
}


#* @schema CitingPaper
#* @property handle string RePEc handle of citing paper
#* @property title string Title of citing paper
#* @property year integer Publication year
#* @property authors string Authors
#* @property journal string Journal name
#* @property category string Category code
#* @property is_series boolean Series indicator
#* @property url string URL to paper
NULL

#* Get papers that cite a given handle
#* @get /citedby
#* @serializer json
#* @apiResponse 200 {array} CitingPaper List of papers citing this handle
#* @param handle:string RePEc handle to query
#* @param limit:number Maximum results (default 50)
function(handle, limit = 50) {
  get_citing_papers(handle = handle, limit = as.integer(limit))
}

#* @schema CitedPaper
#* @property handle string RePEc handle of cited paper
#* @property title string Title of cited paper
#* @property year integer Publication year
#* @property authors string Authors
#* @property journal string Journal name
#* @property category string Category code
#* @property is_series boolean Series indicator
#* @property url string URL to paper
NULL

#* Get papers cited by a given handle
#* @get /cites
#* @serializer json
#* @apiResponse 200 {array} CitedPaper List of papers cited by this handle
#* @param handle:string RePEc handle to query
#* @param limit:number Maximum results (default 50)
function(handle, limit = 50) {
  get_cited_papers(handle = handle, limit = as.integer(limit))
}

#* @schema CitationCounts
#* @property total_citations integer Total citations from all papers
#* @property internal_citations integer Citations from papers in database
NULL

#* Get citation counts for a handle
#* @get /citationcounts
#* @serializer json
#* @apiResponse 200 {object} CitationCounts Citation count statistics
#* @param handle:string RePEc handle to query
function(handle) {
  get_citation_counts(handle = handle)
}
