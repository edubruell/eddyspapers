#' Chunk a parquet diff file for API upload
#'
#' Reads a parquet file and splits it into chunks of approximately target_mb size.
#' Uses DuckDB to efficiently read and chunk the file based on disk size.
#'
#' @param file_path Path to the parquet file in pqt_diff folder
#' @param target_mb Target chunk size in megabytes (default 1)
#' @param pqt_diff_folder Path to diff folder. Defaults to config$pqt_diff_folder
#' @return List of data frames, each representing a chunk
#' @export
chunk_parquet_for_upload <- function(file_path, 
                                     target_mb = 1,
                                     pqt_diff_folder = NULL) {
  
  if (is.null(pqt_diff_folder)) {
    config <- get_folder_config()
    pqt_diff_folder <- config$pqt_diff_folder
  }
  
  full_path <- if (fs::is_absolute_path(file_path)) {
    file_path
  } else {
    file.path(pqt_diff_folder, file_path)
  }
  
  if (!file.exists(full_path)) {
    stop("File not found: ", full_path)
  }
  
  file_size_mb <- file.info(full_path)$size / 1024^2
  info("File size: ", round(file_size_mb, 2), " MB")
  
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  
  full_path_norm <- normalizePath(full_path, winslash = "/", mustWork = TRUE)
  
  DBI::dbExecute(con, sprintf(
    "CREATE TEMP TABLE full_data AS SELECT * FROM read_parquet('%s')",
    full_path_norm
  ))
  
  total_rows <- DBI::dbGetQuery(con, "SELECT COUNT(*) as n FROM full_data")$n
  
  if (total_rows == 0) {
    info("Empty file, returning empty list")
    return(list())
  }
  
  num_chunks <- ceiling(file_size_mb / target_mb)
  rows_per_chunk <- ceiling(total_rows / num_chunks)
  
  info("Splitting ", total_rows, " rows into ", num_chunks, " chunks (~", 
       rows_per_chunk, " rows each)")
  
  chunks <- vector("list", num_chunks)
  
  for (i in seq_len(num_chunks)) {
    offset <- (i - 1) * rows_per_chunk
    
    chunk_df <- DBI::dbGetQuery(con, sprintf(
      "SELECT * FROM full_data LIMIT %d OFFSET %d",
      rows_per_chunk, offset
    ))
    
    chunks[[i]] <- chunk_df
    info("  Chunk ", i, "/", num_chunks, ": ", nrow(chunk_df), " rows")
  }
  
  chunks
}