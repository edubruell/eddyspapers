args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) {
  message("Usage: Rscript --vanilla run.R <script_path> <db_path>")
  quit(status = 1)
}

script_path <- args[[1]]
db_path     <- args[[2]]

file_arg <- grep("--file=", commandArgs(FALSE), value = TRUE)
if (length(file_arg) == 0) {
  message("run.R must be invoked via Rscript --vanilla run.R ...")
  quit(status = 1)
}
script_dir <- normalizePath(dirname(sub("--file=", "", file_arg[[1]])))
pkg_dir    <- file.path(script_dir, "eddysearch.sandbox")

if (requireNamespace("eddysearch.sandbox", quietly = TRUE)) {
  suppressPackageStartupMessages(library(eddysearch.sandbox, quietly = TRUE))
} else {
  pkgload::load_all(pkg_dir, quiet = TRUE)
}

connect_db(db_path)

tryCatch(
  source(script_path, local = FALSE),
  error = function(e) {
    emit_event(list(type = "error", message = conditionMessage(e), recoverable = FALSE))
    quit(status = 1)
  }
)

if (length(.sandbox_state$bibtex_handles) > 0) {
  bib_rows <- bib_for(.sandbox_state$bibtex_handles)
  combined <- paste(bib_rows$bib_tex[nchar(bib_rows$bib_tex) > 0], collapse = "\n\n")
  if (nchar(combined) > 0) {
    emit_event(list(type = "bibtex", entries = nrow(bib_rows), bibtex = combined))
  }
}
