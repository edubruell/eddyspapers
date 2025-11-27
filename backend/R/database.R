#' Initialize articles table in database
#'
#' Creates the articles table schema if it doesn't exist.
#'
#' @param con DuckDB connection
#' @return TRUE invisibly
init_articles_table <- function(con) {
  if ("articles" %in% DBI::dbListTables(con)) {
    return(invisible(TRUE))
  }
  
  DBI::dbExecute(con, "
    CREATE TABLE articles (
      Handle VARCHAR,
      title VARCHAR,
      abstract VARCHAR,
      pages VARCHAR,
      vol VARCHAR,
      issue VARCHAR,
      number VARCHAR,
      archive VARCHAR,
      journal_code VARCHAR,
      year INTEGER,
      is_series BOOLEAN,
      journal VARCHAR,
      category VARCHAR,
      url VARCHAR,
      authors VARCHAR,
      bib_tex VARCHAR,
      embeddings FLOAT[1024]
    )
  ")
  
  invisible(TRUE)
}

#' Get list of processed paper handles
#'
#' Returns all paper handles already in the database.
#'
#' @param con DuckDB connection
#' @return Character vector of handles
get_processed_handles <- function(con) {
  if ("articles" %in% DBI::dbListTables(con)) {
    DBI::dbGetQuery(con, "SELECT Handle FROM articles")$Handle
  } else {
    character(0)
  }
}

#' Load and clean parsed paper collection
#'
#' Loads all parsed RDS files, deduplicates, filters by year and abstract length,
#' and joins with journal metadata.
#'
#' @param rds_folder Path to RDS files. Defaults to config$rds_folder
#' @param journals_csv Path to journals CSV. Defaults to config$journals_csv
#' @return Cleaned collection as tibble
#' @export
load_cleaned_collection <- function(rds_folder = NULL, 
                                    journals_csv = NULL) {
  if (is.null(rds_folder)) {
    config <- get_folder_config()
    rds_folder <- config$rds_folder
  }
  
  if (is.null(journals_csv)) {
    config <- get_folder_config()
    journals_csv <- config$journals_csv
  }
  
  full_article_data <- list.files(rds_folder, full.names = TRUE) |>
    purrr::map_dfr(~readRDS(.x))
  
  no_dup <- full_article_data |>
    dplyr::group_by(Handle) |>
    dplyr::slice(1) |>
    dplyr::ungroup()
  
  collection_all_files <- no_dup |>
    dplyr::select(Handle,
                  title,
                  abstract,
                  pages,
                  vol = volume,
                  issue,
                  number,
                  archive,
                  journal_code,
                  year,
                  is_series,
                  authors = authors_string,
                  bib_tex = bib_tex,
                  file) |>
    dplyr::filter((year >= 1995 & !is_series) | (year >= 2010 & is_series)) |>
    dplyr::filter(nchar(abstract) > 100) |>
    dplyr::left_join(
      readr::read_csv(journals_csv, show_col_types = FALSE) |>
        dplyr::transmute(archive,
                         journal_code = journal,
                         journal = long_name,
                         category),
      by = c("archive", "journal_code")
    ) |>
    dplyr::mutate(
      journal_bt = paste0("journal = {", journal, "}"),
      bib_tex = stringr::str_replace(bib_tex, "journal = \\{\\}", journal_bt),
      bib_tex = stringr::str_replace_all(bib_tex, "\\n\\s*\\n", "\n")
    ) |>
    dplyr::select(-journal_bt)
  
  article_urls <- collection_all_files |>
    dplyr::select(Handle, file) |>
    tidyr::unnest(file) |>
    tidyr::unnest(cols = c("format", "url")) |>
    dplyr::group_by(Handle) |>
    dplyr::slice(1) |>
    dplyr::ungroup() |>
    dplyr::select(Handle, url)
  
  cleaned_collection <- collection_all_files |>
    dplyr::select(-file) |>
    dplyr::left_join(article_urls, by = "Handle") |>
    dplyr::mutate(year = stringr::str_replace_all(year, "Forthcoming", "2025"))
  
  cleaned_collection
}

#' Process and insert a batch of embeddings
#'
#' Generates embeddings for a batch of papers and inserts them into the database.
#'
#' @param batch Data frame batch with paper data
#' @param con DuckDB connection
#' @param num_batches Total number of batches (for progress reporting)
#' @param model Ollama embedding model name
#' @return NULL invisibly
process_embedding_batch <- function(batch, con, num_batches, 
                                   model = "mxbai-embed-large") {
  current_batch <- unique(batch$batch)
  glue::glue("Processing batch {current_batch} of {num_batches}") |> cat("\n")
  
  emb_result <- batch$abstract |>
    tidyllm::ollama_embedding(.model = model)
  
  batch_with_embeddings <- batch |>
    dplyr::bind_cols(emb_result |> dplyr::select(-input))
  
  batch_with_embeddings |>
    dplyr::copy_to(
      con,
      df = _,
      name = "temp_batch",
      temporary = TRUE,
      overwrite = TRUE
    )
  
  DBI::dbExecute(con, "
    INSERT INTO articles 
    SELECT 
      Handle, title, abstract, pages, vol, issue, number, 
      archive, journal_code, year, is_series, journal, 
      category, url, authors, bib_tex, embeddings
    FROM temp_batch
  ")
  
  DBI::dbExecute(con, "DROP TABLE temp_batch")
}

#' Create database indices
#'
#' Creates standard B-tree indices and HNSW vector index for similarity search.
#'
#' @param con DuckDB connection
#' @return Indices data frame invisibly
#' @export
create_indices <- function(con) {
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_year ON articles(year)")
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_category ON articles(category)")
  DBI::dbExecute(con, "LOAD vss;")
  DBI::dbExecute(con, "SET hnsw_enable_experimental_persistence=true;")
  DBI::dbExecute(con, "DROP INDEX IF EXISTS idx_hnsw;")
  DBI::dbExecute(con, "CREATE INDEX idx_hnsw ON articles USING HNSW (embeddings);")
  
  indices <- DBI::dbGetQuery(con, "
    SELECT *
    FROM duckdb_indexes()
    WHERE table_name = 'articles';
  ")
  
  message("Created indices:")
  print(indices)
  
  invisible(indices)
}

#' Generate embeddings and populate database
#'
#' Main function to load parsed papers, generate embeddings, and populate the database.
#' Only processes papers not already in the database.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param rds_folder Path to RDS files. Defaults to config$rds_folder
#' @param journals_csv Path to journals CSV. Defaults to config$journals_csv
#' @param batch_size Number of papers to process per batch
#' @param model Ollama embedding model name
#' @return Data frame of processed papers invisibly
#' @export
embed_and_populate_db <- function(db_path = NULL,
                                  rds_folder = NULL,
                                  journals_csv = NULL,
                                  batch_size = 50,
                                  model = "mxbai-embed-large") {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbExecute(con, "LOAD vss;")
  
  init_articles_table(con)
  processed_handles <- get_processed_handles(con)
  
  cleaned_collection <- load_cleaned_collection(rds_folder, journals_csv)
  
  to_embed <- cleaned_collection |>
    dplyr::filter(!Handle %in% processed_handles)
  
  if (nrow(to_embed) == 0) {
    message("No new articles to process.")
    DBI::dbDisconnect(con)
    return(invisible(NULL))
  }
  
  message("Processing ", nrow(to_embed), " new articles...")
  
  batches <- to_embed |>
    dplyr::mutate(batch = ceiling(dplyr::row_number() / batch_size)) |>
    dplyr::group_by(batch) |>
    dplyr::group_split()
  
  batches |>
    purrr::walk(~process_embedding_batch(.x, con, length(batches), model))
  
  create_indices(con)
  
  DBI::dbDisconnect(con)
  
  invisible(to_embed)
}

#' Dump database to Parquet files
#'
#' Exports all tables (articles, saved_searches, search_logs) to Parquet files for backup or transfer.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param pqt_folder Path to parquet output folder. Defaults to config$pqt_folder
#' @return Named list of parquet file paths invisibly
#' @export
dump_db_to_parquet <- function(db_path = NULL, pqt_folder = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  if (is.null(pqt_folder)) {
    config <- get_folder_config()
    pqt_folder <- config$pqt_folder
  }
  
  if (!dir.exists(pqt_folder)) {
    dir.create(pqt_folder, recursive = TRUE, showWarnings = FALSE)
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE)
  
  tables <- DBI::dbListTables(con)
  date_stamp <- Sys.Date()
  pqt_files <- list()
  
  if ("articles" %in% tables) {
    articles <- DBI::dbReadTable(con, "articles")
    articles_file <- file.path(pqt_folder, paste0("articles_", date_stamp, ".parquet"))
    arrow::write_parquet(articles, articles_file)
    pqt_files$articles <- articles_file
    message("Dumped articles table to: ", articles_file)
  }
  
  if ("saved_searches" %in% tables) {
    saved_searches <- DBI::dbReadTable(con, "saved_searches")
    saved_file <- file.path(pqt_folder, paste0("saved_searches_", date_stamp, ".parquet"))
    arrow::write_parquet(saved_searches, saved_file)
    pqt_files$saved_searches <- saved_file
    message("Dumped saved_searches table to: ", saved_file)
  }
  
  if ("search_logs" %in% tables) {
    search_logs <- DBI::dbReadTable(con, "search_logs")
    logs_file <- file.path(pqt_folder, paste0("search_logs_", date_stamp, ".parquet"))
    arrow::write_parquet(search_logs, logs_file)
    pqt_files$search_logs <- logs_file
    message("Dumped search_logs table to: ", logs_file)
  }
  
  DBI::dbDisconnect(con)
  
  invisible(pqt_files)
}

#' Restore database from Parquet files
#'
#' Recreates the database from Parquet backup files, including indices.
#'
#' @param pqt_folder Path to folder containing parquet files
#' @param date_stamp Date stamp of backup (YYYY-MM-DD). If NULL, uses most recent files.
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @return Path to database invisibly
#' @export
restore_db_from_parquet <- function(pqt_folder = NULL, 
                                    date_stamp = NULL, 
                                    db_path = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  if (is.null(pqt_folder)) {
    config <- get_folder_config()
    pqt_folder <- config$pqt_folder
  }
  
  if (!dir.exists(pqt_folder)) {
    stop("Parquet folder not found: ", pqt_folder)
  }
  
  if (is.null(date_stamp)) {
    all_files <- list.files(pqt_folder, pattern = "\\.parquet$", full.names = FALSE)
    dates <- stringr::str_extract(all_files, "\\d{4}-\\d{2}-\\d{2}")
    date_stamp <- max(dates[!is.na(dates)])
    message("Using most recent backup: ", date_stamp)
  }
  
  articles_file <- file.path(pqt_folder, paste0("articles_", date_stamp, ".parquet"))
  saved_file <- file.path(pqt_folder, paste0("saved_searches_", date_stamp, ".parquet"))
  logs_file <- file.path(pqt_folder, paste0("search_logs_", date_stamp, ".parquet"))
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbExecute(con, "LOAD vss;")
  
  if (file.exists(articles_file)) {
    articles <- arrow::read_parquet(articles_file)
    
    if ("articles" %in% DBI::dbListTables(con)) {
      DBI::dbExecute(con, "DROP TABLE articles")
    }
    
    DBI::dbWriteTable(con, "articles", articles)
    create_indices(con)
    message("Restored articles table from: ", articles_file)
  } else {
    warning("Articles file not found: ", articles_file)
  }
  
  if (file.exists(saved_file)) {
    saved_searches <- arrow::read_parquet(saved_file)
    
    if ("saved_searches" %in% DBI::dbListTables(con)) {
      DBI::dbExecute(con, "DROP TABLE saved_searches")
    }
    
    DBI::dbWriteTable(con, "saved_searches", saved_searches)
    message("Restored saved_searches table from: ", saved_file)
  } else {
    message("No saved_searches file found for this date")
  }
  
  if (file.exists(logs_file)) {
    search_logs <- arrow::read_parquet(logs_file)
    
    if ("search_logs" %in% DBI::dbListTables(con)) {
      DBI::dbExecute(con, "DROP TABLE search_logs")
    }
    
    DBI::dbWriteTable(con, "search_logs", search_logs)
    
    max_id <- DBI::dbGetQuery(con, "SELECT MAX(search_id) as max_id FROM search_logs")$max_id
    if (!is.na(max_id)) {
      DBI::dbExecute(con, sprintf("CREATE OR REPLACE SEQUENCE search_logs_seq START %d", max_id + 1))
    }
    
    message("Restored search_logs table from: ", logs_file)
  } else {
    message("No search_logs file found for this date")
  }
  
  DBI::dbDisconnect(con)
  
  invisible(db_path)
}
