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
function(query,
         max_k = 100,
         min_year = NULL,
         journal_filter = NULL,
         journal_name = NULL,
         title_keyword = NULL,
         author_keyword = NULL) {
  
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
  res |> dplyr::arrange(dplyr::desc(similarity_score))
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
