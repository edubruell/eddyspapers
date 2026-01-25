search_papers_tool <- ellmer::tool(
  function(query,
           max_k = 100,
           min_year = NULL,
           journal_filter = NULL,
           journal_name = NULL,
           title_keyword = NULL,
           author_keyword = NULL) {

    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    body <- list(
      query = query,
      max_k = max_k
    )

    if (!is.null(min_year)) body$min_year <- min_year
    if (!is.null(journal_filter)) body$journal_filter <- journal_filter
    if (!is.null(journal_name)) body$journal_name <- journal_name
    if (!is.null(title_keyword)) body$title_keyword <- title_keyword
    if (!is.null(author_keyword)) body$author_keyword <- author_keyword

    resp <- httr2::request(paste0(base_url, "/search")) |>
      httr2::req_method("POST") |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_body_json(body) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    tibble::tibble(
      handle = purrr::map_chr(result, "Handle"),
      title = purrr::map_chr(result, "title"),
      year = purrr::map_int(result, "year"),
      authors = purrr::map_chr(result, "authors"),
      journal = purrr::map_chr(result, "journal"),
      category = purrr::map_chr(result, "category"),
      url = purrr::map_chr(result, "url", .default = NA_character_),
      similarity_score = purrr::map_dbl(result, "similarity_score"),
      abstract = purrr::map_chr(result, "abstract", .default = NA_character_)
    )
  },
  name = "search_papers",
  description = "Search economics papers using semantic embeddings with optional filters. Returns papers ranked by similarity to query.",
  query = ellmer::type_string(
    "Research query or question to search for. The system will generate embeddings and find semantically similar papers."
  ),
  max_k = ellmer::type_integer(
    "Maximum number of results to return (default 100)."
  ),
  min_year = ellmer::type_integer(
    "Filter to papers published in or after this year."
  ),
  journal_filter = ellmer::type_string(
    "Comma-separated category codes: '1' (Top 5), '2' (AEJs), '3' (General Interest), '4' (Top Field A), '5' (Second Field B), '6' (Other), '7' (Working Papers). Default is categories 1-5."
  ),
  journal_name = ellmer::type_string(
    "Comma-separated journal names or substrings for filtering."
  ),
  title_keyword = ellmer::type_string(
    "Keyword to filter paper titles (case-insensitive substring match)."
  ),
  author_keyword = ellmer::type_string(
    "Keyword to filter paper authors (case-insensitive substring match)."
  )
)

get_versions_tool <- ellmer::tool(
  function(handle) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/versions")) |>
      httr2::req_url_query(handle = handle) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    if (length(result) == 0) {
      return(tibble::tibble())
    }

    tibble::tibble(
      source = purrr::map_chr(result, "source"),
      target = purrr::map_chr(result, "target"),
      type = purrr::map_chr(result, "type"),
      year = purrr::map_int(result, "year", .default = NA_integer_),
      title = purrr::map_chr(result, "title", .default = NA_character_),
      authors = purrr::map_chr(result, "authors", .default = NA_character_),
      journal = purrr::map_chr(result, "journal", .default = NA_character_),
      url = purrr::map_chr(result, "url", .default = NA_character_)
    )
  },
  name = "get_paper_versions",
  description = "Get alternative versions of a paper (working papers, series versions, journal versions). Useful for finding full-text when main version is not accessible.",
  handle = ellmer::type_string(
    "RePEc handle to query (e.g., 'repec:eee:dyncon:v:123:y:2020:i:c:p:104050')."
  )
)

get_citing_papers_tool <- ellmer::tool(
  function(handle, limit = 50) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/citedby")) |>
      httr2::req_url_query(handle = handle, limit = limit) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    if (length(result) == 0) {
      return(tibble::tibble())
    }

    tibble::tibble(
      handle = purrr::map_chr(result, "handle"),
      title = purrr::map_chr(result, "title", .default = NA_character_),
      year = purrr::map_int(result, "year", .default = NA_integer_),
      authors = purrr::map_chr(result, "authors", .default = NA_character_),
      journal = purrr::map_chr(result, "journal", .default = NA_character_),
      category = purrr::map_chr(result, "category", .default = NA_character_),
      url = purrr::map_chr(result, "url", .default = NA_character_)
    )
  },
  name = "get_citing_papers",
  description = "Get papers that cite a given paper. Useful for finding influence chains and related work.",
  handle = ellmer::type_string(
    "RePEc handle to query."
  ),
  limit = ellmer::type_integer(
    "Maximum number of citing papers to return (default 50)."
  )
)

get_cited_papers_tool <- ellmer::tool(
  function(handle, limit = 50) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/cites")) |>
      httr2::req_url_query(handle = handle, limit = limit) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    if (length(result) == 0) {
      return(tibble::tibble())
    }

    tibble::tibble(
      handle = purrr::map_chr(result, "handle"),
      title = purrr::map_chr(result, "title", .default = NA_character_),
      year = purrr::map_int(result, "year", .default = NA_integer_),
      authors = purrr::map_chr(result, "authors", .default = NA_character_),
      journal = purrr::map_chr(result, "journal", .default = NA_character_),
      category = purrr::map_chr(result, "category", .default = NA_character_),
      url = purrr::map_chr(result, "url", .default = NA_character_)
    )
  },
  name = "get_cited_papers",
  description = "Get papers cited by a given paper (its references). Useful for understanding the theoretical foundation and related work.",
  handle = ellmer::type_string(
    "RePEc handle to query."
  ),
  limit = ellmer::type_integer(
    "Maximum number of cited papers to return (default 50)."
  )
)

get_citation_counts_tool <- ellmer::tool(
  function(handle) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/citationcounts")) |>
      httr2::req_url_query(handle = handle) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    httr2::resp_body_json(resp)
  },
  name = "get_citation_counts",
  description = "Get total and internal citation counts for a paper. Internal citations are from papers in the database.",
  handle = ellmer::type_string(
    "RePEc handle to query."
  )
)

get_handle_stats_tool <- ellmer::tool(
  function(handle) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/handlestats")) |>
      httr2::req_url_query(handle = handle) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    httr2::resp_body_json(resp)
  },
  name = "get_handle_statistics",
  description = "Get comprehensive precomputed citation and impact statistics for a paper including: citation counts, percentiles, weighted citations, citer quality metrics, Top 5 share, citations by year, and category breakdowns.",
  handle = ellmer::type_string(
    "RePEc handle to query."
  )
)

get_database_stats_tool <- ellmer::tool(
  function() {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    total_resp <- httr2::request(paste0(base_url, "/stats/total")) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    updated_resp <- httr2::request(paste0(base_url, "/stats/last_updated")) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    cats_resp <- httr2::request(paste0(base_url, "/stats/categories")) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    total <- httr2::resp_body_json(total_resp)
    updated <- httr2::resp_body_json(updated_resp)
    cats <- httr2::resp_body_json(cats_resp)

    categories <- tibble::tibble(
      category = purrr::map_chr(cats, "category"),
      count = purrr::map_int(cats, "n")
    )

    list(
      total_articles = total$total_articles,
      last_updated = updated$last_updated,
      categories = categories
    )
  },
  name = "get_database_statistics",
  description = "Get overall database statistics including total article count, last update date, and article counts by category (Top 5, AEJs, General Interest, etc.)."
)

save_search_tool <- ellmer::tool(
  function(query,
           max_k = 100,
           min_year = NULL,
           journal_filter = NULL,
           journal_name = NULL,
           title_keyword = NULL,
           author_keyword = NULL) {

    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    body <- list(
      query = query,
      max_k = max_k
    )

    if (!is.null(min_year)) body$min_year <- min_year
    if (!is.null(journal_filter)) body$journal_filter <- journal_filter
    if (!is.null(journal_name)) body$journal_name <- journal_name
    if (!is.null(title_keyword)) body$title_keyword <- title_keyword
    if (!is.null(author_keyword)) body$author_keyword <- author_keyword

    resp <- httr2::request(paste0(base_url, "/search/save")) |>
      httr2::req_method("POST") |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_body_json(body) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    message("Search saved with hash: ", result$hash)
    message("Retrieve with: https://econpapers.eduard-bruell.de/search/", result$hash)

    papers <- tibble::tibble(
      handle = purrr::map_chr(result$results, "Handle"),
      title = purrr::map_chr(result$results, "title"),
      year = purrr::map_int(result$results, "year"),
      authors = purrr::map_chr(result$results, "authors"),
      journal = purrr::map_chr(result$results, "journal"),
      similarity_score = purrr::map_dbl(result$results, "similarity_score")
    )

    list(
      hash = result$hash,
      url = paste0("https://econpapers.eduard-bruell.de/search/", result$hash),
      papers = papers
    )
  },
  name = "save_search",
  description = "Execute a search and save it with a deterministic hash. Returns the hash and a shareable URL. Useful for creating persistent search results that can be referenced later.",
  query = ellmer::type_string(
    "Research query or question to search for."
  ),
  max_k = ellmer::type_integer(
    "Maximum number of results to return (default 100)."
  ),
  min_year = ellmer::type_integer(
    "Filter to papers published in or after this year."
  ),
  journal_filter = ellmer::type_string(
    "Comma-separated category codes: '1' (Top 5), '2' (AEJs), '3' (General Interest), '4' (Top Field A), '5' (Second Field B), '6' (Other), '7' (Working Papers)."
  ),
  journal_name = ellmer::type_string(
    "Comma-separated journal names or substrings for filtering."
  ),
  title_keyword = ellmer::type_string(
    "Keyword to filter paper titles."
  ),
  author_keyword = ellmer::type_string(
    "Keyword to filter paper authors."
  )
)

get_saved_search_tool <- ellmer::tool(
  function(hash) {
    api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)
    if (is.na(api_key)) {
      stop("EDDYPAPERS_API_KEY environment variable not set")
    }

    base_url <- Sys.getenv("EDDYPAPERS_API_URL",
                          "https://econpapers.eduard-bruell.de/api")

    resp <- httr2::request(paste0(base_url, "/search/", hash)) |>
      httr2::req_headers(`X-API-Key` = api_key) |>
      httr2::req_perform()

    result <- httr2::resp_body_json(resp)

    if (!is.null(result$error)) {
      stop("Search not found: ", result$error)
    }

    papers <- tibble::tibble(
      handle = purrr::map_chr(result$results, "Handle"),
      title = purrr::map_chr(result$results, "title"),
      year = purrr::map_int(result$results, "year"),
      authors = purrr::map_chr(result$results, "authors"),
      journal = purrr::map_chr(result$results, "journal"),
      similarity_score = purrr::map_dbl(result$results, "similarity_score")
    )

    list(
      hash = result$hash,
      query = result$query,
      max_k = result$max_k,
      min_year = result$min_year,
      journal_filter = result$journal_filter,
      created_at = result$created_at,
      papers = papers
    )
  },
  name = "get_saved_search",
  description = "Retrieve a previously saved search by its hash. Returns the original query parameters and results.",
  hash = ellmer::type_string(
    "8-character search hash (from save_search or URL)."
  )
)

#' Start MCP server for Eddy's Papers
#'
#' Launches an MCP server exposing economics paper search and citation tools.
#'
#' @param type Transport type: "stdio" or "http"
#' @param host Host for HTTP server
#' @param port Port for HTTP server
#' @param session_tools Include session management tools
#' @return Does not return (blocks)
#' @export
start_eddypapers_mcp <- function(type = "stdio",
                                 host = "127.0.0.1",
                                 port = 8080,
                                 session_tools = FALSE) {

  if (is.na(Sys.getenv("EDDYPAPERS_API_KEY", unset = NA))) {
    warning("EDDYPAPERS_API_KEY not set. Tools will fail.")
  }

  tools <- list(
    search_papers_tool,
    get_versions_tool,
    get_citing_papers_tool,
    get_cited_papers_tool,
    get_citation_counts_tool,
    get_handle_stats_tool,
    get_database_stats_tool,
    save_search_tool,
    get_saved_search_tool
  )

  mcptools::mcp_server(
    tools = tools,
    type = type,
    host = host,
    port = port,
    session_tools = session_tools
  )
}
