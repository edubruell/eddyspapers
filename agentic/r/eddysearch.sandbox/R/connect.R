connect_db <- function(db_path) {
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE)
  .sandbox_state$con <- con

  pragmas <- c(
    "SET disabled_filesystems = 'LocalFileSystem,HTTPFileSystem,S3FileSystem'",
    "SET autoinstall_known_extensions = false",
    "SET autoload_known_extensions = false",
    "SET allow_unsigned_extensions = false",
    "SET enable_external_access = false",
    "SET lock_configuration = true"
  )

  purrr::walk(pragmas, function(p) {
    tryCatch(DBI::dbExecute(con, p), error = function(e) invisible(NULL))
  })

  .sandbox_state$fd3 <- tryCatch(
    {
      fd3 <- file(sprintf("/dev/fd/3"), open = "w")
      fd3
    },
    error = function(e) NULL
  )

  invisible(NULL)
}
