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

# Attach the data-analysis packages the allowlist advertises so bare calls
# (mutate, map, str_glue, glue, pivot_wider, …) resolve at runtime and dplyr::filter
# masks stats::filter. eddysearch.sandbox is loaded LAST so its verbs win any name clash.
suppressWarnings(suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
  library(stringr)
  library(purrr)
  library(glue)
  if (requireNamespace("eddysearch.sandbox", quietly = TRUE)) {
    library(eddysearch.sandbox, quietly = TRUE)
  } else {
    pkgload::load_all(pkg_dir, quiet = TRUE)
  }
}))

# `.sandbox_state` is an internal package env. Under `pkgload::load_all` (dev) it
# is visible at top level, but under an installed `library()` (prod) it is not —
# reach it via the namespace so the bibtex tail below works in both modes.
.sandbox_state <- getNamespace("eddysearch.sandbox")[[".sandbox_state"]]

connect_db(db_path)

# Defense-in-depth (layer 2). check.R statically rejects dangerous functions, but its
# value-position guard is a denylist and cannot be exhaustive of base/utils — a
# non-blocked function passed to a higher-order function (`Reduce(make.socket, …)`)
# resolves, at runtime, through the search path to the real primitive. The script is
# sourced in globalenv, which is searched *before* base/utils, so binding throwing stubs
# here shadows those primitives: any that slip the static checker fail closed instead of
# executing. Package/tidyverse internals are unaffected (they resolve in their own
# namespaces, whose parent is base, not globalenv). A user variable assigned in-script
# simply rebinds the name and overrides its stub.
.sandbox_blocked <- c(
  "system", "system2", "shell", "pipe",
  "make.socket", "close.socket", "read.socket", "write.socket", "serverSocket",
  "socketConnection", "url", "file", "fifo", "gzfile", "bzfile", "xzfile", "unz",
  "download.file", "curl_download", "readRenviron",
  "source", "sys.source", "getExportedValue", "getNamespaceExports", "getFunction",
  "getAnywhere", "getMethod", "selectMethod", "getS3method", "Recall",
  "assign", "delayedAssign", "makeActiveBinding", "lockBinding",
  "serialize", "unserialize", "readRDS", "saveRDS", "save", "load", "save.image",
  "readLines", "writeLines", "writeChar", "writeBin", "readBin", "readChar", "scan",
  "file.append", "file.link", "file.symlink", "file.rename", "file.remove", "unlink",
  "file.create", "file.copy", "dir.create", "Sys.chmod", "Sys.setFileTime",
  "Sys.readlink", "setwd", "dyn.load", "dyn.unload", "library.dynam",
  "install.packages", "Sys.getenv", "Sys.setenv", "Sys.unsetenv",
  "library", "require", "requireNamespace", "loadNamespace", "attachNamespace"
)
# NB: two families are intentionally NOT masked at runtime — both are already statically
# blocked by check.R, and rlang/tidyverse resolve them internally in caller-adjacent
# contexts, so masking them in globalenv breaks legitimate NSE / quosure evaluation:
#   • the eval/parse family (eval, evalq, eval.parent, parse, str2lang, str2expression)
#   • the get / environment family (get, get0, mget, match.fun, environment,
#     parent.frame, globalenv, as.environment, list2env, …)
# base::assign / base::local — the loop masks `assign` and (potentially) `local`
# themselves, so reach them explicitly or the loop would shadow its own machinery.
for (.nm in .sandbox_blocked) {
  base::assign(.nm, base::local({
    blocked <- .nm
    function(...) stop(sprintf("`%s` is disabled in the sandbox", blocked), call. = FALSE)
  }), envir = globalenv())
}
base::rm(.nm, .sandbox_blocked)

# base:: — `source` is shadowed by the layer-2 stub above; run.R is trusted, so reach
# the real one explicitly to load the (already AST-checked) user script.
tryCatch(
  base::source(script_path, local = FALSE),
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
