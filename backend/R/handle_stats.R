#' Initialize handle_stats table
#'
#' Creates the handle_stats table schema if it doesn't exist.
#'
#' @param con DuckDB connection
#' @return TRUE invisibly
#' @export
init_handle_stats_table <- function(con) {
  if ("handle_stats" %in% DBI::dbListTables(con)) {
    return(invisible(TRUE))
  }
  
  DBI::dbExecute(con, "
    CREATE TABLE handle_stats (
      handle VARCHAR PRIMARY KEY,
      
      pub_year INTEGER,
      years_since_pub INTEGER,
      
      total_citations INTEGER,
      internal_citations INTEGER,
      total_references INTEGER,
      citations_per_year DOUBLE,
      citation_percentile DOUBLE,
      
      citations_by_year JSON,
      
      median_citer_percentile DOUBLE,
      weighted_citations DOUBLE,
      top5_citer_share DOUBLE,
      max_citer_percentile DOUBLE,
      mean_citer_percentile DOUBLE,
      
      top_citing_journal VARCHAR,
      
      citer_category_counts JSON,
      citer_category_shares JSON
    )
  ")
  
  info("Created handle_stats table")
  invisible(TRUE)
}


#' Compute and populate handle statistics
#'
#' Computes comprehensive citation statistics for all articles in the database.
#' Uses temporary views and tables for readable SQL execution.
#'
#' @param con DuckDB connection
#' @return Number of handles processed
#' @export
compute_handle_stats <- function(con) {
  info("Computing handle statistics...")
  
  DBI::dbExecute(con, "DROP TABLE IF EXISTS handle_stats")
  init_handle_stats_table(con)
  
  current_year <- as.integer(format(Sys.Date(), "%Y"))
  
  info("  Step 1/7: Creating base article view...")
  DBI::dbExecute(con, sprintf("
    CREATE TEMP VIEW base_articles AS
    SELECT 
      LOWER(Handle) as handle,
      year as pub_year,
      %d - year as years_since_pub,
      journal,
      category
    FROM articles
    WHERE year IS NOT NULL
  ", current_year))
  
  info("  Step 2/7: Computing citation counts...")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW citation_counts AS
    SELECT 
      ba.handle,
      COALESCE(ca.total_cites, 0) as total_citations,
      COALESCE(ci.internal_cites, 0) as internal_citations
    FROM base_articles ba
    LEFT JOIN (
      SELECT cited, COUNT(*) as total_cites
      FROM cit_all
      GROUP BY cited
    ) ca ON ba.handle = ca.cited
    LEFT JOIN (
      SELECT cited, COUNT(*) as internal_cites
      FROM cit_internal
      GROUP BY cited
    ) ci ON ba.handle = ci.cited
  ")
  
  info("  Step 3/7: Computing reference counts...")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW reference_counts AS
    SELECT 
      ba.handle,
      COALESCE(ra.total_refs, 0) as total_references
    FROM base_articles ba
    LEFT JOIN (
      SELECT citing, COUNT(*) as total_refs
      FROM cit_all
      GROUP BY citing
    ) ra ON ba.handle = ra.citing
  ")
  
  info("  Step 4/7: Computing first-order metrics...")
  DBI::dbExecute(con, sprintf("
    CREATE TEMP VIEW first_order_stats AS
    SELECT 
      ba.handle,
      ba.pub_year,
      ba.years_since_pub,
      cc.total_citations,
      cc.internal_citations,
      rc.total_references,
      CASE 
        WHEN ba.years_since_pub > 0 THEN cc.total_citations * 1.0 / ba.years_since_pub
        ELSE 0.0
      END as citations_per_year,
      PERCENT_RANK() OVER (ORDER BY cc.total_citations) as citation_percentile
    FROM base_articles ba
    JOIN citation_counts cc ON ba.handle = cc.handle
    JOIN reference_counts rc ON ba.handle = rc.handle
  "))
  
  info("  Step 5/7: Computing citations by year...")
  DBI::dbExecute(con, "
    CREATE TEMP VIEW citations_by_year_view AS
    SELECT 
      ci.cited as handle,
      json_object(
        'years', json_group_array(year ORDER BY year),
        'counts', json_group_array(cite_count ORDER BY year)
      ) as citations_by_year
    FROM (
      SELECT 
        ci.cited,
        a.year,
        COUNT(*) as cite_count
      FROM cit_internal ci
      JOIN articles a ON LOWER(a.Handle) = ci.citing
      WHERE a.year IS NOT NULL
      GROUP BY ci.cited, a.year
    ) ci
    GROUP BY ci.cited
  ")
  
  info("  Step 6/7: Computing second-order metrics...")
  
  DBI::dbExecute(con, "
    CREATE TEMP VIEW citer_category_agg AS
    SELECT 
      ci.cited,
      citer.category,
      COUNT(*) as category_count
    FROM cit_internal ci
    JOIN base_articles citer ON ci.citing = citer.handle
    WHERE citer.category IS NOT NULL
    GROUP BY ci.cited, citer.category
  ")
  
  DBI::dbExecute(con, "
    CREATE TEMP VIEW citer_category_totals AS
    SELECT 
      cited,
      SUM(category_count) as total_citers
    FROM citer_category_agg
    GROUP BY cited
  ")
  
  DBI::dbExecute(con, "
    CREATE TEMP VIEW citer_category_json AS
    SELECT
      ca.cited,
      json_object_agg(ca.category, ca.category_count) as citer_category_counts,
      json_object_agg(
        ca.category, 
        ca.category_count * 1.0 / ct.total_citers
      ) as citer_category_shares
    FROM citer_category_agg ca
    JOIN citer_category_totals ct ON ca.cited = ct.cited
    GROUP BY ca.cited
  ")
  
  DBI::dbExecute(con, "
    CREATE TEMP VIEW second_order_stats AS
    SELECT 
      cited.handle,
      COALESCE(so.median_citer_percentile, 0.0) as median_citer_percentile,
      COALESCE(so.mean_citer_percentile, 0.0) as mean_citer_percentile,
      COALESCE(so.max_citer_percentile, 0.0) as max_citer_percentile,
      COALESCE(so.weighted_citations, 0.0) as weighted_citations,
      COALESCE(so.top5_share, 0.0) as top5_citer_share,
      so.top_citing_journal,
      ccj.citer_category_counts,
      ccj.citer_category_shares
    FROM base_articles cited
    LEFT JOIN (
      SELECT 
        ci.cited,
        MEDIAN(citer_stats.citation_percentile) as median_citer_percentile,
        AVG(citer_stats.citation_percentile) as mean_citer_percentile,
        MAX(citer_stats.citation_percentile) as max_citer_percentile,
        SUM(citer_stats.citation_percentile) as weighted_citations,
        SUM(CASE WHEN citer.category = 'Top 5 Journals' THEN 1 ELSE 0 END) * 1.0 / 
          NULLIF(COUNT(*), 0) as top5_share,
        MODE(citer.journal) as top_citing_journal
      FROM cit_internal ci
      JOIN base_articles citer ON ci.citing = citer.handle
      JOIN first_order_stats citer_stats ON citer.handle = citer_stats.handle
      GROUP BY ci.cited
    ) so ON cited.handle = so.cited
    LEFT JOIN citer_category_json ccj ON cited.handle = ccj.cited
  ")
  
  info("  Step 7/7: Populating handle_stats table...")
  DBI::dbExecute(con, "
    INSERT INTO handle_stats
    SELECT 
      fos.handle,
      fos.pub_year,
      fos.years_since_pub,
      fos.total_citations,
      fos.internal_citations,
      fos.total_references,
      fos.citations_per_year,
      fos.citation_percentile,
      COALESCE(cby.citations_by_year, '{}') as citations_by_year,
      sos.median_citer_percentile,
      sos.weighted_citations,
      sos.top5_citer_share,
      sos.max_citer_percentile,
      sos.mean_citer_percentile,
      sos.top_citing_journal,
      COALESCE(sos.citer_category_counts, '{}') as citer_category_counts,
      COALESCE(sos.citer_category_shares, '{}') as citer_category_shares
    FROM first_order_stats fos
    LEFT JOIN citations_by_year_view cby ON fos.handle = cby.handle
    JOIN second_order_stats sos ON fos.handle = sos.handle
  ")
  
  info("  Cleaning up temporary views...")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS base_articles")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS citation_counts")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS reference_counts")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS first_order_stats")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS citations_by_year_view")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS citer_category_agg")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS citer_category_totals")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS citer_category_json")
  DBI::dbExecute(con, "DROP VIEW IF EXISTS second_order_stats")
  
  stats_count <- DBI::dbGetQuery(con, "SELECT COUNT(*) as n FROM handle_stats")$n
  info("✓ Computed statistics for ", stats_count, " handles")
  
  invisible(stats_count)
}


#' Get handle statistics
#'
#' Retrieves precomputed statistics for one or more article handles.
#'
#' @param con DuckDB connection
#' @param handles Character vector of article handles (case-insensitive)
#' @return Data frame with statistics, or NULL if handles not found
#' @export
get_handle_stats <- function(con, handles) {
  if (!"handle_stats" %in% DBI::dbListTables(con)) {
    warning("handle_stats table does not exist. Run compute_handle_stats() first.")
    return(NULL)
  }
  
  handles_lower <- tolower(handles)
  
  query <- "SELECT * FROM handle_stats WHERE handle IN (?)"
  result <- DBI::dbGetQuery(con, query, params = list(handles_lower))
  
  if (nrow(result) == 0) {
    return(NULL)
  }
  
  result
}
#TODO: Implement a computating function for a handle_stats table 
#      for all article handles in the DB to power a 
#      simple pre-computed retrieval function in the API.
#
#   Most computations seem feasible in the duckdb
#
# Needed Handle-Stats:
#  - Total Citations (total_citations) - Will be a Stats Badge in the frontend
#  - Citations within the articles database (internal_citations) - Will be a part of the first badge
#  - Total references (total_references) - Will be a Stats Badge in the frontend
#  - Publication Year (pub_year) - Needed internally
#  - Years since Publication (years_since_pub) - Needed internally
# -  Citations per year (citations_per_year) - Will be a Stats Badge in the frontend
#  - Percentile in overall Citation Distribution (citation_percentile) - Will be a Stats Badge in the frontend
#     #-> Here we could add a simple second order Stat (cited by other top-citation rank papers - need to think what this could be)
#  - Top citing Journal (top_citing_journal) - Extra Info for the later stats field
#  - A list of citations by year to power a small frontend CitationSparkline
# 
# Schemm Idea: 
# CREATE TABLE handle_stats (
#   handle VARCHAR PRIMARY KEY,
#   
#   /* Core bibliographic fields */
#     pub_year INTEGER,
#   years_since_pub INTEGER,
#   
#   /* First order citation stats */
#     total_citations INTEGER,
#   internal_citations INTEGER,
#   total_references INTEGER,
#   citations_per_year DOUBLE,
#   citation_percentile DOUBLE,
#   
#   /* Distributional details */
#     citations_by_year JSON,
#   
#   /* Second order citation stats */
#   /* Median Percentile Rank of Papers that cite this paper */
#   median_citer_percentile DOUBLE,
#   /* A percentile rank weighted citation count */
#   weighted_citations DOUBLE,
#   /* Share of citations coming from the Top5, the category column in articles can have the value "Top 5 Journals" */
#   top5_citer_share DOUBLE,  
#   
#   /* Additional second-order network metrics (optional but cheap to compute) */
#     max_citer_percentile DOUBLE,
#     mean_citer_percentile DOUBLE,
#   
#   /* Top citing journal */
#     top_citing_journal VARCHAR,
#   
#   /* Category-level citer breakdown */
#     citer_category_counts JSON,
#     citer_category_shares JSON
# );
# 



#TODO: Add a bibliographic coupling table 
# 
# DBI::dbExecute(con, "
#     CREATE TABLE bib_coupling (
#       handle_a VARCHAR,
#       handle_b VARCHAR,
#       shared_refs INTEGER,
#       coupling_strength DOUBLE,
#       PRIMARY KEY (handle_a, handle_b)
#     )
#   ")
# 
# Coupling Stength could be shared refs over all refs. 
# The idea is to add an extra Top 5 papers with most similar references retriever in the API
