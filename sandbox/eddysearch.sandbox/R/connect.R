# The OS/filesystem/network lockdown for the sandbox DB, as an ordered vector so it has a
# single source of truth and is testable (test-connect.R).
# ORDER MATTERS: `enable_external_access = false` must run BEFORE `disabled_filesystems`.
# Reversed (as it was), disabling LocalFileSystem first makes the enable_external_access SET
# raise "File system LocalFileSystem has been disabled" — which the previous swallowing
# tryCatch hid, so external access was in fact NEVER disabled in prod. `lock_configuration`
# stays last (it seals further SETs).
lockdown_pragmas <- function() {
  c(
    "SET autoinstall_known_extensions = false",
    "SET autoload_known_extensions = false",
    "SET allow_unsigned_extensions = false",
    "SET enable_external_access = false",
    "SET disabled_filesystems = 'LocalFileSystem,HTTPFileSystem,S3FileSystem'",
    "SET lock_configuration = true"
  )
}

# Apply the lockdown, FAILING CLOSED. These pragmas ARE the sandbox isolation for the DB;
# if a DuckDB rename/removal/order-change makes one error, swallowing it would silently hand
# back an unlocked connection. Abort loudly instead so the sandbox refuses to run unprotected.
apply_lockdown <- function(con) {
  purrr::walk(lockdown_pragmas(), function(p) {
    tryCatch(
      DBI::dbExecute(con, p),
      error = function(e) stop(paste0("Sandbox DB lockdown failed on `", p, "`: ", conditionMessage(e)))
    )
  })
}

connect_db <- function(db_path) {
  con <- DBI::dbConnect(duckdb::duckdb(), dbdir = db_path, read_only = TRUE)
  .sandbox_state$con <- con

  # Load required extensions before the security lockdown prevents auto-loading
  purrr::walk(c("LOAD json", "LOAD vss"), function(sql) {
    tryCatch(DBI::dbExecute(con, sql), error = function(e) invisible(NULL))
  })

  apply_lockdown(con)

  .sandbox_state$fd3 <- tryCatch(
    {
      fd3 <- file(sprintf("/dev/fd/3"), open = "w")
      fd3
    },
    error = function(e) NULL
  )

  invisible(NULL)
}
