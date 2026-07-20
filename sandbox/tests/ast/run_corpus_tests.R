suppressPackageStartupMessages(library(jsonlite))

script_dir <- normalizePath(
  dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)[[1]]))
)
check_script <- file.path(script_dir, "..", "..", "check.R")
good_dir     <- file.path(script_dir, "good")
bad_dir      <- file.path(script_dir, "bad")

run_check <- function(script_path) {
  raw <- system2("Rscript", c("--vanilla", check_script, script_path),
                 stdout = TRUE, stderr = FALSE)
  tryCatch(
    fromJSON(paste(raw, collapse = ""), simplifyVector = FALSE),
    error = function(e) list(ok = FALSE, reason = paste("Unparseable output:", paste(raw, collapse = " ")),
                             offending_node = "", hint = "")
  )
}

good_scripts <- sort(list.files(good_dir, pattern = "\\.R$", full.names = TRUE))
bad_scripts  <- sort(list.files(bad_dir,  pattern = "\\.R$", full.names = TRUE))

failures <- 0

cat("=== Good corpus ===\n")
for (f in good_scripts) {
  result <- run_check(f)
  name   <- basename(f)
  if (isTRUE(result$ok)) {
    cat(sprintf("  PASS  %s\n", name))
  } else {
    cat(sprintf("  FAIL  %s\n        reason: %s\n        node:   %s\n",
                name, result$reason, result$offending_node))
    failures <- failures + 1
  }
}

cat("\n=== Bad corpus ===\n")
for (f in bad_scripts) {
  result <- run_check(f)
  name   <- basename(f)
  if (!isTRUE(result$ok) && nchar(result$hint %||% "") > 0) {
    cat(sprintf("  PASS  %s\n        reason: %s\n", name, result$reason))
  } else if (!isTRUE(result$ok)) {
    cat(sprintf("  WARN  %s  (rejected but hint is empty)\n        reason: %s\n",
                name, result$reason))
    failures <- failures + 1
  } else {
    cat(sprintf("  FAIL  %s  (expected rejection, got ok=true)\n", name))
    failures <- failures + 1
  }
}

`%||%` <- function(a, b) if (!is.null(a)) a else b

cat(sprintf(
  "\n%d good + %d bad scripts checked. %s\n",
  length(good_scripts), length(bad_scripts),
  if (failures == 0) "All passed." else paste0(failures, " FAILURE(S).")
))

quit(status = if (failures == 0) 0 else 1)
