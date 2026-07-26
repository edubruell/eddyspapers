# Shared across the emit tests: run `expr` with fd3 pointed at a temp file, then read back
# the emitted events as parsed JSON. testthat sources helper-*.R before any test file.
capture_events <- function(expr) {
  tmp <- tempfile()
  con <- file(tmp, "w")
  old <- .sandbox_state$fd3
  .sandbox_state$fd3 <- con
  on.exit({
    try(close(con), silent = TRUE)
    .sandbox_state$fd3 <- old
    unlink(tmp)
  })
  force(expr)
  flush(con)
  close(con)
  .sandbox_state$fd3 <- old
  lines <- readLines(tmp)
  lapply(lines[nchar(lines) > 0], jsonlite::fromJSON)
}
