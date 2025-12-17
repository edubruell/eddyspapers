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


#' Get database connection
#'
#' Simple helper to open a connection to the articles database.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param read_only Logical, whether to open in read-only mode. Default FALSE.
#' @return DuckDB connection object
#' @export
get_db_con <- function(db_path = NULL, read_only = FALSE) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = read_only)
  DBI::dbExecute(con, "LOAD vss;")
  
  con
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
  info("Processing batch ", current_batch, " of ", num_batches)
  
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
  
  info("Created indices:")
  info(paste(capture.output(print(indices)), collapse = "\n"))
  
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
    info("No new articles to process.")
    DBI::dbDisconnect(con)
    return(invisible(NULL))
  }
  
  info("Processing ", nrow(to_embed), " new articles...")
  
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


#' Write version links to database
#'
#' Processes version relationships from the rw object and writes them to the version_links table.
#' Only includes links where both source and target papers exist in the database.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param rw_file Path to a RePEc Related Works file. Defaults to config$repec/cpd/conf/relatedworks.dat
#' @return NULL invisibly
#' @export
write_version_links_to_db <- function(db_path = NULL,
                                      rw_file = NULL){
  if(is.null(rw_file)){
    config  <- get_folder_config()
    rw_file <- get_folder_refs(config)$repec("cpd","conf","relatedworks.dat")
  }
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }

  rw <- parse_relatedworks_perl(rw_file) 
  info("Related Works parsed succesfully")
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  DBI::dbExecute(con, "LOAD vss;")
  
  init_articles_table(con)
  processed_handles <- get_processed_handles(con)
  
  processed_handles_norm <- tolower(processed_handles)
  
  rw_filtered <- rw[processed_handles_norm %in% names(rw)]
  
  version_links <- purrr::imap_dfr(
    rw_filtered,
    function(relcats, src) {
      purrr::imap_dfr(
        relcats,
        function(targets, relcat) {
          tibble::tibble(
            source = src,
            target = names(targets),
            type = relcat
          )
        }
      )
    }
  )
  
  info("Version links created internally")
  
  names(processed_handles) <- processed_handles_norm
  
  version_links  |>
    dplyr::filter(source %in% processed_handles_norm,
                  target %in% processed_handles_norm) |>
    dplyr::mutate(target = processed_handles[target],
                  source = processed_handles[source]) |>
    dplyr::copy_to(
      con,
      df = _,
      name = "version_links",
      temporary = FALSE,
      overwrite = TRUE
    )
} 



#' Initialize citation tables in database
#'
#' Creates cit_all and cit_internal tables with indices if they don't exist.
#'
#' @param con DuckDB connection
#' @return TRUE invisibly
#' @export
init_citations_tables <- function(con) {
  
  if (!"cit_all" %in% DBI::dbListTables(con)) {
    DBI::dbExecute(con, "
      CREATE TABLE cit_all (
        citing VARCHAR,
        cited VARCHAR
      )
    ")
    info("Created cit_all table")
  }
  
  if (!"cit_internal" %in% DBI::dbListTables(con)) {
    DBI::dbExecute(con, "
      CREATE TABLE cit_internal (
        citing VARCHAR,
        cited VARCHAR
      )
    ")
    info("Created cit_internal table")
  }
  
  invisible(TRUE)
}


#' Build internal citation graph from cit_all
#'
#' Creates cit_internal table by filtering cit_all to only include edges
#' where both citing and cited handles exist in the articles table.
#' Also creates indices on both columns for fast lookups.
#'
#' @param con DuckDB connection
#' @return Number of internal edges created
#' @export
build_internal_citation_graph <- function(con) {
  info("Building internal citation graph...")
  
  DBI::dbExecute(con, "DROP TABLE IF EXISTS cit_internal")
  
  DBI::dbExecute(con, "
    CREATE TABLE cit_internal AS
    SELECT citing, cited
    FROM cit_all
    WHERE citing IN (SELECT LOWER(Handle) FROM articles)
      AND cited IN (SELECT LOWER(Handle) FROM articles)
  ")
  
  internal_count <- DBI::dbGetQuery(con, "SELECT COUNT(*) as n FROM cit_internal")$n
  info("Created ", internal_count, " internal citation edges")
  
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_cit_all_citing ON cit_all(citing)")
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_cit_all_cited ON cit_all(cited)")
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_cit_internal_citing ON cit_internal(citing)")
  DBI::dbExecute(con, "CREATE INDEX IF NOT EXISTS idx_cit_internal_cited ON cit_internal(cited)")
  
  info("Created citation indices")
  
  invisible(internal_count)
}


#' Populate citation tables from iscited file
#'
#' Main orchestrator function for citation data population.
#' Initializes tables, parses iscited file, and builds internal graph.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param iscited_file Path to iscited.txt file. Defaults to config$repec_folder/cit/conf/iscited.txt
#' @param chunk_size Number of lines to read per chunk
#' @param commit_every Number of edges to buffer before committing
#' @return List with counts of total and internal edges
#' @export
populate_citations <- function(
    db_path = NULL,
    iscited_file = NULL,
    chunk_size = 50000,
    commit_every = 50000
) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  if (is.null(iscited_file)) {
    config <- get_folder_config()
    iscited_file <- file.path(config$repec_folder, "cit", "conf", "iscited.txt")
  }
  
  if (!file.exists(iscited_file)) {
    stop("iscited.txt not found at: ", iscited_file)
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  
  init_citations_tables(con)
  
  DBI::dbExecute(con, "DELETE FROM cit_all")
  info("Cleared existing cit_all table")
  
  total_edges <- parse_iscited_streaming(
    file = iscited_file,
    con = con,
    chunk_size = chunk_size,
    commit_every = commit_every
  )
  
  internal_edges <- build_internal_citation_graph(con)
  
  DBI::dbDisconnect(con)
  
  invisible(list(
    total_edges = total_edges,
    internal_edges = internal_edges
  ))
}


#' Dump database to Parquet files
#'
#' Exports all tables (articles, saved_searches, search_logs,version_links) to Parquet files using DuckDB's COPY command.
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
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = FALSE)
  
  tables <- DBI::dbListTables(con)
  date_stamp <- format(Sys.time(), "%Y%m%d_%H%M%S")
  pqt_files <- list()
  
  export_tbl <- function(tbl) {
    file_path <- file.path(pqt_folder, paste0(tbl, "_", date_stamp, ".parquet"))
    sql <- sprintf("COPY %s TO '%s' (FORMAT PARQUET)", tbl, file_path)
    DBI::dbExecute(con, sql)
    info("Dumped ", tbl, " table to: ", file_path)
    file_path
  }
  
  pqt_files <- tables |>
    purrr::set_names() |>
    purrr::keep(~.x %in% c("articles", "saved_searches", "search_logs", "version_links", "cit_all", "cit_internal", "handle_stats")) |>
    purrr::map(export_tbl)
  
  
  DBI::dbDisconnect(con)
  
  invisible(pqt_files)
}


#' Restore database from Parquet files
#'
#' Recreates the database from Parquet backup files, including indices.
#'
#' @param pqt_folder Path to folder containing parquet files
#' @param date_stamp Backup suffix. If NULL, picks the most recent found in articles_*.parquet
#' @param db_path Path to DuckDB database
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
  
  # Pick most recent backup stamp from articles_*.parquet
  if (is.null(date_stamp)) {
    article_files <- list.files(
      pqt_folder,
      pattern = "^articles_.*\\.parquet$",
      full.names = FALSE
    )
    
    if (!length(article_files)) {
      stop("No articles_*.parquet backups found in: ", pqt_folder)
    }
    
    stamps <- sub("^articles_(.*)\\.parquet$", "\\1", article_files)
    date_stamp <- max(stamps)
    info("Using backup stamp: ", date_stamp)
  }
  
  # All tables we might restore
  tables <- c(
    "articles",
    "saved_searches",
    "search_logs",
    "version_links",
    "cit_all",
    "cit_internal",
    "handle_stats"
  )
  
  pqt_paths <- file.path(pqt_folder, paste0(tables, "_", date_stamp, ".parquet"))
  names(pqt_paths) <- tables
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  DBI::dbExecute(con, "LOAD vss;")
  
  # Helper to restore a table via DuckDB's read_parquet
  load_tbl <- function(tbl) {
    file <- pqt_paths[[tbl]]
    if (!file.exists(file)) {
      info("No ", tbl, " file found for stamp ", date_stamp)
      return(FALSE)
    }
    
    file_norm <- normalizePath(file, winslash = "/", mustWork = TRUE)
    DBI::dbExecute(con, sprintf("DROP TABLE IF EXISTS %s", tbl))
    
    DBI::dbExecute(
      con,
      sprintf("
        CREATE TABLE %s AS
        SELECT * FROM read_parquet('%s')
      ", tbl, file_norm)
    )
    
    info("Restored ", tbl)
    TRUE
  }
  
  # Articles gets indices
  if (load_tbl("articles")) {
    # Make sure embeddings is a fixed-size FLOAT[1024] array
    DBI::dbExecute(
      con,
      "
    ALTER TABLE articles
    ALTER COLUMN embeddings
    TYPE FLOAT[1024]
    USING CAST(embeddings AS FLOAT[1024])
    "
    )
    
    create_indices(con)
  } else {
    warn("Articles table missing in backup; database incomplete.")
  }
  
  load_tbl("saved_searches")
  load_tbl("search_logs")
  load_tbl("version_links")
  
  has_cit_all      <- load_tbl("cit_all")
  has_cit_internal <- load_tbl("cit_internal")
  
  if (has_cit_all) {
    DBI::dbExecute(con, "
      CREATE INDEX IF NOT EXISTS idx_cit_all_citing ON cit_all(citing);
    ")
    DBI::dbExecute(con, "
      CREATE INDEX IF NOT EXISTS idx_cit_all_cited  ON cit_all(cited);
    ")
  }
  
  if (has_cit_internal) {
    DBI::dbExecute(con, "
      CREATE INDEX IF NOT EXISTS idx_cit_internal_citing ON cit_internal(citing);
    ")
    DBI::dbExecute(con, "
      CREATE INDEX IF NOT EXISTS idx_cit_internal_cited  ON cit_internal(cited);
    ")
  }
  
  load_tbl("handle_stats")
  
  invisible(db_path)
}


#' Record database content update time
#'
#' Records the last successful database rebuild or update.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param time POSIXct or Date; defaults to Sys.time()
#' @return Recorded date (YYYY-MM-DD) invisibly
#' @export
record_db_update_time <- function(db_path = NULL, time = Sys.time()) {
  
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS db_metadata (
      key VARCHAR PRIMARY KEY,
      value VARCHAR
    )
  ")
  
  date_str <- format(as.POSIXct(time), "%Y-%m-%d")
  
  DBI::dbExecute(
    con,
    "DELETE FROM db_metadata WHERE key = 'last_content_update'"
  )
  
  DBI::dbExecute(
    con,
    "INSERT INTO db_metadata (key, value) VALUES (?, ?)",
    params = list("last_content_update", date_str)
  )
  
  invisible(date_str)
}



#' Get database tables with sizes and schemas
#'
#' Returns a list containing a tibble of all database tables with their sizes
#' and a list of tibbles with the schema (columns and types) for each table.
#' Size is calculated from actual database file size on disk.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @return List with three elements:
#'   - tables: tibble with columns table_name, row_count, size_mb
#'   - schemas: named list of tibbles, one per table, with column names and types
#'   - total_db_size_mb: total database file size on disk
#' @export
get_db_info <- function(db_path = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  total_size_mb <- file.info(db_path)$size / 1024^2
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE)
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  tables <- DBI::dbListTables(con)
  
  table_info <- purrr::map_dfr(tables, function(tbl) {
    row_count <- DBI::dbGetQuery(
      con,
      sprintf("SELECT COUNT(*) as n FROM %s", tbl)
    )$n
    
    tibble::tibble(
      table_name = tbl,
      row_count = row_count
    )
  })
  
  total_rows <- sum(table_info$row_count)
  
  table_info <- table_info |>
    dplyr::mutate(
      size_mb = (row_count / total_rows) * total_size_mb
    )
  
  schemas <- purrr::map(tables, function(tbl) {
    DBI::dbGetQuery(
      con,
      sprintf("DESCRIBE %s", tbl)
    ) |>
      tibble::as_tibble()
  }) |>
    purrr::set_names(tables)
  
  list(
    tables = table_info,
    schemas = schemas,
    total_db_size_mb = total_size_mb
  )
}


#' Compute differences between two parquet dumps
#'
#' Creates diff files showing NEW, DELETE, and UPDATE operations between two parquet dumps.
#' Each table gets one diff file with an operation column indicating the change type.
#'
#' @param base_stamp Timestamp of base/older dump (e.g., "20250101_120000")
#' @param update_stamp Timestamp of newer dump (e.g., "20250115_120000")
#' @param pqt_folder Path to parquet folder. Defaults to config$pqt_folder
#' @param pqt_diff_folder Path to diff output folder. Defaults to config$pqt_diff_folder
#' @param tables Vector of table names to diff. Defaults to main tables.
#' @return Named list of diff file paths invisibly
#' @export
compute_parquet_diffs <- function(base_stamp,
                                  update_stamp,
                                  pqt_folder = NULL,
                                  pqt_diff_folder = NULL,
                                  tables = c("articles", "handle_stats", "cit_all", 
                                            "cit_internal", "version_links")) {
  
  if (is.null(pqt_folder)) {
    config <- get_folder_config()
    pqt_folder <- config$pqt_folder
  }
  
  if (is.null(pqt_diff_folder)) {
    config <- get_folder_config()
    pqt_diff_folder <- config$pqt_diff_folder
  }
  
  if (!dir.exists(pqt_diff_folder)) {
    dir.create(pqt_diff_folder, recursive = TRUE, showWarnings = FALSE)
  }
  
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  table_keys <- list(
    articles = "Handle",
    handle_stats = "handle",
    cit_all = c("citing", "cited"),
    cit_internal = c("citing", "cited"),
    version_links = c("source", "target", "type")
  )
  
  diff_files <- list()
  
  for (tbl in tables) {
    base_file <- file.path(pqt_folder, paste0(tbl, "_", base_stamp, ".parquet"))
    update_file <- file.path(pqt_folder, paste0(tbl, "_", update_stamp, ".parquet"))
    
    if (!file.exists(base_file)) {
      info("Skipping ", tbl, ": base file not found")
      next
    }
    
    if (!file.exists(update_file)) {
      info("Skipping ", tbl, ": update file not found")
      next
    }
    
    info("Computing diff for ", tbl, "...")
    
    base_norm <- normalizePath(base_file, winslash = "/", mustWork = TRUE)
    update_norm <- normalizePath(update_file, winslash = "/", mustWork = TRUE)
    
    DBI::dbExecute(con, sprintf("DROP TABLE IF EXISTS base_%s", tbl))
    DBI::dbExecute(con, sprintf("DROP TABLE IF EXISTS update_%s", tbl))
    
    DBI::dbExecute(con, sprintf(
      "CREATE TEMP TABLE base_%s AS SELECT * FROM read_parquet('%s')",
      tbl, base_norm
    ))
    
    DBI::dbExecute(con, sprintf(
      "CREATE TEMP TABLE update_%s AS SELECT * FROM read_parquet('%s')",
      tbl, update_norm
    ))
    
    keys <- table_keys[[tbl]]
    key_clause <- paste(keys, collapse = ", ")
    
    if (tbl == "articles") {
      
      join_conditions <- paste(
        sprintf("b.%s = u.%s", keys, keys),
        collapse = " AND "
      )
      
      compare_cols <- DBI::dbGetQuery(con, sprintf("DESCRIBE base_%s", tbl))$column_name
      compare_cols <- setdiff(compare_cols, c(keys, "embeddings"))
      
      compare_conditions <- paste(
        sprintf("(b.%s IS DISTINCT FROM u.%s)", compare_cols, compare_cols),
        collapse = " OR "
      )
      
      diff_sql <- sprintf("
        SELECT *, 'NEW' as operation FROM update_%s
        WHERE %s NOT IN (SELECT %s FROM base_%s)
        
        UNION ALL
        
        SELECT *, 'DELETE' as operation FROM base_%s
        WHERE %s NOT IN (SELECT %s FROM update_%s)
        
        UNION ALL
        
        SELECT u.*, 'UPDATE' as operation
        FROM base_%s b
        JOIN update_%s u ON %s
        WHERE %s
      ", tbl, key_clause, key_clause, tbl,
         tbl, key_clause, key_clause, tbl,
         tbl, tbl, join_conditions, compare_conditions)
      
    } else {
      
      diff_sql <- sprintf("
        SELECT *, 'NEW' as operation FROM update_%s
        WHERE (%s) NOT IN (SELECT %s FROM base_%s)
        
        UNION ALL
        
        SELECT *, 'DELETE' as operation FROM base_%s
        WHERE (%s) NOT IN (SELECT %s FROM update_%s)
      ", tbl, key_clause, key_clause, tbl,
         tbl, key_clause, key_clause, tbl)
    }
    
    diff_file <- file.path(
      pqt_diff_folder, 
      sprintf("%s_diff_%s_%s.parquet", tbl, base_stamp, update_stamp)
    )
    
    diff_file_norm <- normalizePath(
      diff_file, 
      winslash = "/", 
      mustWork = FALSE
    )
    
    copy_sql <- sprintf(
      "COPY (%s) TO '%s' (FORMAT PARQUET)",
      diff_sql,
      diff_file_norm
    )
    
    DBI::dbExecute(con, copy_sql)
    
    diff_count <- DBI::dbGetQuery(con, sprintf(
      "SELECT COUNT(*) as n FROM (%s) diff",
      diff_sql
    ))$n
    
    info("  ", tbl, ": ", diff_count, " changes → ", basename(diff_file))
    diff_files[[tbl]] <- diff_file
  }
  
  invisible(diff_files)
}



#' Apply parquet diff files to database
#'
#' Applies diff files created by compute_parquet_diffs() to a database.
#' Handles NEW (insert), UPDATE (replace), and DELETE operations.
#'
#' @param base_stamp Base timestamp used in diff filenames
#' @param update_stamp Update timestamp used in diff filenames
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param pqt_diff_folder Path to diff folder. Defaults to config$pqt_diff_folder
#' @param tables Vector of table names to apply. Defaults to main tables.
#' @param rebuild_indices Whether to rebuild indices after applying changes. Default TRUE.
#' @return Named list with counts of operations applied per table
#' @export
apply_parquet_diffs <- function(base_stamp,
                                update_stamp,
                                db_path = NULL,
                                pqt_diff_folder = NULL,
                                tables = c("articles", "handle_stats", "cit_all",
                                          "cit_internal", "version_links"),
                                rebuild_indices = TRUE) {
  
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  
  if (is.null(pqt_diff_folder)) {
    config <- get_folder_config()
    pqt_diff_folder <- config$pqt_diff_folder
  }
  
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path)
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  DBI::dbExecute(con, "LOAD vss;")
  
  table_keys <- list(
    articles = "Handle",
    handle_stats = "handle",
    cit_all = c("citing", "cited"),
    cit_internal = c("citing", "cited"),
    version_links = c("source", "target", "type")
  )
  
  results <- list()
  
  for (tbl in tables) {
    diff_file <- file.path(
      pqt_diff_folder,
      sprintf("%s_diff_%s_%s.parquet", tbl, base_stamp, update_stamp)
    )
    
    if (!file.exists(diff_file)) {
      info("Skipping ", tbl, ": diff file not found")
      next
    }
    
    info("Applying diff for ", tbl, "...")
    
    diff_file_norm <- normalizePath(diff_file, winslash = "/", mustWork = TRUE)
    
    DBI::dbExecute(con, "DROP TABLE IF EXISTS temp_diff")
    DBI::dbExecute(con, sprintf(
      "CREATE TEMP TABLE temp_diff AS SELECT * FROM read_parquet('%s')",
      diff_file_norm
    ))
    
    op_counts <- DBI::dbGetQuery(con, "
      SELECT operation, COUNT(*) as count
      FROM temp_diff
      GROUP BY operation
    ")
    
    info("  Operations: ", paste(
      sprintf("%s=%d", op_counts$operation, op_counts$count),
      collapse = ", "
    ))
    
    keys <- table_keys[[tbl]]
    
    if ("DELETE" %in% op_counts$operation) {
      key_where <- if (length(keys) == 1) {
        sprintf("%s IN (SELECT %s FROM temp_diff WHERE operation = 'DELETE')", 
                keys, keys)
      } else {
        sprintf("(%s) IN (SELECT %s FROM temp_diff WHERE operation = 'DELETE')",
                paste(keys, collapse = ", "),
                paste(keys, collapse = ", "))
      }
      
      delete_sql <- sprintf("DELETE FROM %s WHERE %s", tbl, key_where)
      deleted <- DBI::dbExecute(con, delete_sql)
      info("  Deleted ", deleted, " rows")
    }
    
    insert_cols <- DBI::dbGetQuery(con, sprintf("DESCRIBE %s", tbl))$column_name
    insert_cols_str <- paste(insert_cols, collapse = ", ")
    
    new_sql <- sprintf("
      INSERT INTO %s (%s)
      SELECT %s FROM temp_diff
      WHERE operation = 'NEW'
    ", tbl, insert_cols_str, insert_cols_str)
    
    inserted <- DBI::dbExecute(con, new_sql)
    info("  Inserted ", inserted, " new rows")
    
    if ("UPDATE" %in% op_counts$operation) {
      if (tbl %in% c("articles", "handle_stats")) {
        
        key_col <- keys[1]
        update_cols <- setdiff(insert_cols, c(key_col))
        
        set_clause <- paste(
          sprintf("%s = excluded.%s", update_cols, update_cols),
          collapse = ", "
        )
        
        upsert_sql <- sprintf("
          INSERT INTO %s (%s)
          SELECT %s FROM temp_diff WHERE operation = 'UPDATE'
          ON CONFLICT (%s) DO UPDATE SET %s
        ", tbl, insert_cols_str, insert_cols_str, key_col, set_clause)
        
        updated <- DBI::dbExecute(con, upsert_sql)
        info("  Updated ", updated, " rows")
        
      } else {
        
        key_where <- if (length(keys) == 1) {
          sprintf("%s IN (SELECT %s FROM temp_diff WHERE operation = 'UPDATE')", 
                  keys, keys)
        } else {
          sprintf("(%s) IN (SELECT %s FROM temp_diff WHERE operation = 'UPDATE')",
                  paste(keys, collapse = ", "),
                  paste(keys, collapse = ", "))
        }
        
        deleted_for_update <- DBI::dbExecute(con, sprintf(
          "DELETE FROM %s WHERE %s", tbl, key_where
        ))
        
        inserted_for_update <- DBI::dbExecute(con, sprintf("
          INSERT INTO %s (%s)
          SELECT %s FROM temp_diff WHERE operation = 'UPDATE'
        ", tbl, insert_cols_str, insert_cols_str))
        
        info("  Updated ", inserted_for_update, " rows (delete+insert)")
      }
    }
    
    DBI::dbExecute(con, "DROP TABLE temp_diff")
    
    results[[tbl]] <- op_counts
  }
  
  if (rebuild_indices && "articles" %in% tables) {
    info("Rebuilding indices...")
    create_indices(con)
  }
  
  invisible(results)
}
