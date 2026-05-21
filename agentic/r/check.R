suppressPackageStartupMessages(library(jsonlite))

ALLOWED_BASE <- c(
  "c", "list", "vector", "character", "numeric", "integer", "logical", "double",
  "complex", "data.frame", "matrix", "array",
  "length", "nrow", "ncol", "dim", "names", "colnames", "rownames", "NROW", "NCOL",
  "seq", "seq_len", "seq_along", "rev", "sort", "order", "rank", "unique",
  "duplicated", "which", "any", "all", "table",
  "paste", "paste0", "sprintf", "format", "formatC", "prettyNum", "toString",
  "tolower", "toupper", "trimws", "substr", "substring", "startsWith", "endsWith",
  "strsplit", "chartr", "nchar", "nzchar",
  "gsub", "sub", "grepl", "grep", "regmatches", "regexpr", "gregexpr",
  "abs", "sign", "round", "signif", "floor", "ceiling", "trunc", "exp",
  "log", "log2", "log10", "sqrt", "min", "max", "sum", "prod", "cumsum",
  "mean", "median", "quantile", "sd", "var", "cor", "range", "pmin", "pmax",
  "is.na", "is.null", "is.numeric", "is.character", "is.logical", "is.integer",
  "is.double", "is.finite", "is.infinite", "is.nan", "is.function", "is.list",
  "is.data.frame", "is.vector", "is.atomic", "is.recursive", "is.call",
  "is.symbol", "inherits",
  "as.character", "as.numeric", "as.integer", "as.logical", "as.double",
  "as.Date", "as.POSIXct", "as.POSIXlt", "as.data.frame", "as.list",
  "as.vector", "as.matrix",
  "Sys.Date", "Sys.time", "format.Date", "difftime",
  "head", "tail", "append", "setdiff", "union", "intersect", "match",
  "Reduce", "Map", "Filter", "Find", "Position", "mapply", "vapply",
  "sapply", "lapply",
  "print", "message", "warning", "stop",
  "identity", "invisible", "structure", "attr", "attributes",
  "tryCatch", "try", "withCallingHandlers", "on.exit",
  "simpleError", "simpleCondition", "simpleMessage", "simpleWarning",
  "conditionMessage", "conditionCall",
  "which.min", "which.max", "cummax", "cummin", "cumprod",
  "rep", "rep_len",
  "nargs", "missing", "sys.call",
  "Sys.getenv",
  "proc.time", "system.time", "date",
  "do.call", "return", "switch", "match.arg",
  "stopifnot", "exists",
  "Inf", "NaN", "NA", "NA_integer_", "NA_real_", "NA_character_", "NA_complex_",
  "TRUE", "FALSE", "NULL", "T", "F",
  "pi", "LETTERS", "letters", "month.name", "month.abb"
)

ALLOWED_DPLYR <- c(
  "filter", "mutate", "select", "arrange", "desc", "slice", "slice_head",
  "slice_tail", "slice_min", "slice_max", "slice_sample", "distinct",
  "group_by", "ungroup", "summarise", "summarize", "count", "tally",
  "pull", "rename", "rename_with", "relocate", "transmute", "rowwise",
  "left_join", "inner_join", "right_join", "full_join", "anti_join",
  "semi_join", "cross_join", "bind_rows", "bind_cols",
  "case_when", "case_match", "if_else", "coalesce", "na_if", "between", "near",
  "n", "n_distinct", "row_number", "cur_group_id", "cur_group_rows",
  "lag", "lead", "first", "last", "nth",
  "across", "where", "everything", "starts_with", "ends_with", "contains",
  "matches", "num_range", "all_of", "any_of", "last_col",
  "as_tibble", "tibble", "tribble", "glimpse", "add_row", "add_column",
  "is_tibble", "enframe", "deframe"
)

ALLOWED_STRINGR <- c(
  "str_detect", "str_subset", "str_which", "str_count", "str_extract",
  "str_extract_all", "str_match", "str_match_all", "str_replace",
  "str_replace_all", "str_remove", "str_remove_all", "str_to_lower",
  "str_to_upper", "str_to_title", "str_to_sentence", "str_trim",
  "str_squish", "str_pad", "str_trunc", "str_split", "str_split_fixed",
  "str_split_i", "str_c", "str_flatten", "str_flatten_comma",
  "str_length", "str_starts", "str_ends", "str_glue", "str_glue_data",
  "str_locate", "str_locate_all", "str_sub", "str_sub_all",
  "str_dup", "str_wrap", "str_conv",
  "fixed", "regex", "coll", "boundary", "word"
)

ALLOWED_TIDYR <- c(
  "pivot_longer", "pivot_wider", "separate", "separate_rows", "separate_wider_delim",
  "separate_wider_regex", "separate_wider_position",
  "unite", "replace_na", "drop_na", "fill", "nest", "unnest", "unnest_longer",
  "unnest_wider", "hoist", "expand_grid", "crossing", "nesting", "expand",
  "complete", "pack", "unpack"
)

ALLOWED_PURRR <- c(
  "map", "map_chr", "map_dbl", "map_int", "map_lgl", "map_vec",
  "map2", "map2_chr", "map2_dbl", "map2_int", "map2_lgl", "map2_vec",
  "pmap", "pmap_chr", "pmap_dbl", "pmap_int", "pmap_lgl", "pmap_vec",
  "imap", "imap_chr", "imap_dbl", "imap_int", "imap_lgl",
  "walk", "walk2", "iwalk", "pwalk",
  "keep", "keep_at", "discard", "discard_at", "compact",
  "flatten", "list_flatten", "list_c", "list_cbind", "list_rbind",
  "reduce", "reduce2", "accumulate", "accumulate2",
  "set_names", "possibly", "safely", "quietly",
  "every", "some", "none", "detect", "detect_index",
  "pluck", "pluck_depth", "chuck", "assign_in", "modify_in",
  "list_modify", "list_merge", "modify", "modify_at", "modify_if",
  "modify2", "imodify"
)

ALLOWED_SANDBOX <- c(
  "connect_db",
  "semantic_search", "sql_query", "cites", "citedby", "handle_stats",
  "versions", "bib_for", "journals", "categories", "paper_url",
  "emit_section", "emit_bibtex", "emit_note", "emit_event", "emit_progress",
  "fmt_row", "format_results"
)

ALLOWED_CONTROL <- c(
  "if", "else", "for", "while", "repeat", "break", "next",
  "{", "(", "function"
)

ALLOWED_OPS <- c(
  "+", "-", "*", "/", "%%", "%/%", "^",
  "==", "!=", "<", "<=", ">", ">=",
  "&", "|", "&&", "||", "!",
  ":", "%in%", "%*%", "%>%", "|>", "%+%", "%o%",
  "[", "[[", "$", "@", "[<-", "[[<-", "$<-", "@<-",
  "<-", "=", "->", ":=",
  "~", "..."
)

ALL_ALLOWED <- unique(c(
  ALLOWED_BASE, ALLOWED_DPLYR, ALLOWED_STRINGR, ALLOWED_TIDYR,
  ALLOWED_PURRR, ALLOWED_SANDBOX, ALLOWED_CONTROL, ALLOWED_OPS
))

BLOCKED <- c(
  "system", "system2", "shell", "pipe",
  "file", "url", "socketConnection", "gzfile", "bzfile", "xzfile", "unz",
  "download.file", "curl_download",
  "library", "require", "requireNamespace", "loadNamespace",
  "attachNamespace", "attach", "detach",
  "source", "sys.source",
  "parse", "eval", "evalq",
  "body", "formals", "as.function", "match.fun", "Recall",
  "get", "get0", "mget", "getFromNamespace", "getNamespace", "asNamespace",
  "assign", "delayedAssign", "makeActiveBinding",
  "lockBinding", "lockEnvironment",
  "new.env", "globalenv", "baseenv",
  "parent.frame", "parent.env", "sys.function",
  "Sys.setenv", "Sys.unsetenv", "Sys.setlocale", "setwd",
  "unlink", "file.remove", "file.rename", "file.create", "file.copy",
  "file.symlink", "dir.create", "dir.remove",
  "writeLines", "write.csv", "write.table", "write.csv2", "write",
  "saveRDS", "save", "save.image", "sink", "capture.output", "cat",
  "readLines", "read.csv", "read.table", "read.csv2", "readRDS", "load",
  "scan", "readBin", "readChar",
  "dyn.load", "dyn.unload", "library.dynam",
  "quit", "q",
  "options",
  "browser", "debug", "undebug", "debugonce", "trace", "untrace",
  "traceback", "recover"
)

BLOCKED_HINTS <- list(
  system           = "Remove shell calls. Use sandbox data verbs to query the database.",
  system2          = "Remove shell calls. Use sandbox data verbs to query the database.",
  shell            = "Remove shell calls. Use sandbox data verbs to query the database.",
  pipe             = "Remove shell calls. Use sandbox data verbs to query the database.",
  file             = "File connections are not available. Use `sql_query()` for data access.",
  url              = "Network access is not available. Use the sandbox data verbs.",
  download.file    = "Network access is not available in the sandbox.",
  library          = "All needed packages are pre-loaded. Use sandbox verbs and allowlisted tidyverse functions directly.",
  require          = "All needed packages are pre-loaded. Use sandbox verbs and allowlisted tidyverse functions directly.",
  requireNamespace = "All needed packages are pre-loaded.",
  loadNamespace    = "All needed packages are pre-loaded.",
  attachNamespace  = "All needed packages are pre-loaded.",
  source           = "Dynamic code loading is not allowed. Put all logic in a single script.",
  sys.source       = "Dynamic code loading is not allowed. Put all logic in a single script.",
  parse            = "Dynamic code evaluation is not allowed. Write logic directly.",
  eval             = "Dynamic code evaluation is not allowed. Write logic directly.",
  evalq            = "Dynamic code evaluation is not allowed. Write logic directly.",
  body             = "Accessing or modifying function bodies is not allowed.",
  formals          = "Accessing or modifying function formals is not allowed.",
  as.function      = "Creating functions from formals/body is not allowed.",
  match.fun        = "Use function names directly instead of `match.fun()`.",
  get              = "Use local variables assigned with `<-` instead of `get()`.",
  get0             = "Use local variables assigned with `<-` instead of `get0()`.",
  mget             = "Use local variables assigned with `<-` instead of `mget()`.",
  getFromNamespace = "Access package functions via the allowlisted names, not via namespace lookups.",
  getNamespace     = "Access package functions via the allowlisted names.",
  asNamespace      = "Access package functions via the allowlisted names.",
  assign           = "Use local assignment `<-` instead of `assign()`.",
  delayedAssign    = "Use local assignment `<-` instead of `delayedAssign()`.",
  globalenv        = "Global environment access is not allowed.",
  baseenv          = "Base environment access is not allowed.",
  parent.frame     = "Frame access is not allowed.",
  Sys.setenv       = "Environment variable modification is not allowed.",
  Sys.unsetenv     = "Environment variable modification is not allowed.",
  Sys.setlocale    = "Locale modification is not allowed.",
  setwd            = "Directory changes are not allowed in the sandbox.",
  unlink           = "File system writes are not allowed.",
  file.remove      = "File system writes are not allowed.",
  file.create      = "File system writes are not allowed.",
  file.copy        = "File system writes are not allowed.",
  dir.create       = "File system writes are not allowed.",
  writeLines       = "The sandbox does not support file writes. Use `emit_note()` for markdown commentary.",
  write.csv        = "The sandbox does not support file writes. Return data via `emit_section()`.",
  write.table      = "The sandbox does not support file writes. Return data via `emit_section()`.",
  saveRDS          = "The sandbox does not support file writes.",
  save             = "The sandbox does not support file writes.",
  save.image       = "The sandbox does not support file writes.",
  sink             = "Output redirection is not allowed. Use `emit_note()` or `emit_section()`.",
  capture.output   = "Use `emit_note()` or `emit_section()` instead of capturing output.",
  cat              = "Use `emit_note()` for commentary or `emit_section()` for results.",
  readLines        = "Use `sql_query()` to read data from the database.",
  read.csv         = "Use `sql_query()` to read data from the database.",
  read.table       = "Use `sql_query()` to read data from the database.",
  readRDS          = "Use `sql_query()` to read data from the database.",
  load             = "Use `sql_query()` to load data from the database.",
  scan             = "Use `sql_query()` to read data from the database.",
  quit             = "Do not call `quit()` — the sandbox runner controls process exit.",
  q                = "Do not call `q()` — the sandbox runner controls process exit.",
  options          = "`options()` is not allowed. The sandbox environment is fixed.",
  browser          = "Debugging functions are not allowed in sandbox scripts.",
  debug            = "Debugging functions are not allowed in sandbox scripts.",
  undebug          = "Debugging functions are not allowed in sandbox scripts.",
  trace            = "Debugging functions are not allowed in sandbox scripts.",
  untrace          = "Debugging functions are not allowed in sandbox scripts."
)

`%||%` <- function(a, b) if (!is.null(a)) a else b

reject <- function(node, reason, hint = "") {
  offending <- tryCatch(
    paste(deparse(node, width.cutoff = 120L), collapse = " "),
    error = function(e) "<unparseable>"
  )
  cond <- structure(
    class = c("sandbox_rejection", "error", "condition"),
    list(message = reason, reason = reason, offending_node = offending, hint = hint)
  )
  stop(cond)
}

check_call <- function(node) {
  fn_part <- node[[1]]

  if (is.call(fn_part)) {
    op <- tryCatch(as.character(fn_part[[1]]), error = function(e) "")

    if (op == ":::") {
      pkg  <- tryCatch(as.character(fn_part[[2]]), error = function(e) "?")
      func <- tryCatch(as.character(fn_part[[3]]), error = function(e) "?")
      reject(node,
             paste0("`:::` access to `", pkg, ":::", func, "` is not allowed"),
             "Use the documented sandbox verbs and allowlisted tidyverse functions.")
    }

    if (op == "::") {
      pkg  <- tryCatch(as.character(fn_part[[2]]), error = function(e) "?")
      func <- tryCatch(as.character(fn_part[[3]]), error = function(e) "?")
      if (!(pkg == "magrittr" && func == "%>%")) {
        hint <- if (pkg %in% c("DBI", "duckdb", "pool", "RSQLite")) {
          "Use `sql_query()` to run custom SQL against the database."
        } else if (pkg %in% c("ggplot2", "lattice", "plotly")) {
          "Plotting is not available in the sandbox. Return data via `emit_section()`."
        } else {
          "Use the pre-loaded sandbox verbs and allowlisted tidyverse functions."
        }
        reject(node,
               paste0("Direct `::` access to `", pkg, "` is not permitted"),
               hint)
      }
    }
    return()
  }

  if (!is.symbol(fn_part)) return()
  fn_name <- as.character(fn_part)

  if (fn_name == "<<-") {
    reject(node,
           "`<<-` (superassignment) is not allowed",
           "Use `<-` for local assignment.")
  }

  if (fn_name == ":::") {
    reject(node,
           "`:::` access to internal package functions is not allowed",
           "Use the documented sandbox verbs and allowlisted tidyverse functions.")
  }

  if (fn_name == "::") return()

  if (fn_name %in% BLOCKED) {
    hint <- BLOCKED_HINTS[[fn_name]]
    if (is.null(hint)) hint <- paste0("`", fn_name, "()` is not available in the sandbox.")
    reject(node,
           paste0("`", fn_name, "()` is not permitted in sandbox scripts"),
           hint)
  }

  if (fn_name == "do.call") {
    if (length(node) >= 2) {
      first_arg <- node[[2]]
      if (!is.character(first_arg)) {
        reject(node,
               "`do.call()` requires a literal string as its first argument",
               "Replace `do.call(variable, ...)` with a direct function call, or pass the function name as a string literal e.g. `do.call(\"arrange\", ...)`.")
      }
      fn_str <- tryCatch(as.character(first_arg), error = function(e) "")
      if (nchar(fn_str) > 0 && fn_str %in% BLOCKED) {
        reject(node,
               paste0("`do.call(\"", fn_str, "\", ...)` calls a blocked function"),
               BLOCKED_HINTS[[fn_str]] %||% "Use only allowlisted functions.")
      }
      if (nchar(fn_str) > 0 && !fn_str %in% ALL_ALLOWED && !fn_str %in% BLOCKED) {
        reject(node,
               paste0("`do.call(\"", fn_str, "\", ...)` calls a non-allowlisted function"),
               "Use only the documented sandbox verbs and allowlisted functions.")
      }
    }
    return()
  }

  if (!fn_name %in% ALL_ALLOWED) {
    reject(node,
           paste0("Function `", fn_name, "()` is not on the allowlist"),
           "Use only the documented sandbox verbs and base/tidyverse functions listed in the API reference.")
  }
}

check_node <- function(node) {
  if (is.null(node)) return(invisible(NULL))
  if (is.call(node)) {
    check_call(node)
    lapply(as.list(node), check_node)
  } else if (is.character(node) && length(node) == 1) {
    scan_string_literal(node)
  } else if (is.recursive(node)) {
    lapply(as.list(node), check_node)
  }
  invisible(NULL)
}

scan_string_literal <- function(val) {
  if (!is.na(val) && nchar(val) > 1 && startsWith(val, "/") &&
      !startsWith(val, "/tmp/sandbox-out")) {
    reject(val,
           paste0("Absolute path `", val, "` is not allowed"),
           "Files can only be written to /tmp/sandbox-out/. Remove absolute path references.")
  }
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat(toJSON(list(ok = FALSE, reason = "No script path provided",
                  offending_node = "", hint = "Pass the script path as the first argument."),
             auto_unbox = TRUE))
  cat("\n")
  quit(status = 1)
}

script_path <- args[[1]]

script_text <- tryCatch(
  readLines(script_path, warn = FALSE),
  error = function(e) {
    cat(toJSON(list(ok = FALSE,
                    reason = paste0("Cannot read script: ", conditionMessage(e)),
                    offending_node = "",
                    hint = "Ensure the script file exists and is readable."),
               auto_unbox = TRUE))
    cat("\n")
    quit(status = 1)
  }
)

parsed <- tryCatch(
  parse(text = paste(script_text, collapse = "\n"), keep.source = FALSE),
  error = function(e) {
    cat(toJSON(list(ok = FALSE,
                    reason = paste0("Syntax error: ", conditionMessage(e)),
                    offending_node = "",
                    hint = "Fix the syntax error in the script before re-submitting."),
               auto_unbox = TRUE))
    cat("\n")
    quit(status = 1)
  }
)

result <- tryCatch({
  lapply(as.list(parsed), check_node)
  list(ok = TRUE)
},
sandbox_rejection = function(e) {
  list(ok = FALSE, reason = e$reason, offending_node = e$offending_node, hint = e$hint)
},
error = function(e) {
  list(ok = FALSE,
       reason = paste0("Unexpected checker error: ", conditionMessage(e)),
       offending_node = "",
       hint = "Report this as a checker bug.")
})

cat(toJSON(result, auto_unbox = TRUE))
cat("\n")
