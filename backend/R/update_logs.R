
#' Create a log file for RePEc updates
#'
#' @param config List containing configuration options, including optional 'logs' directory path
#' @param name Name pattern for log-file (default: "repec_update_")
#' @return Path to created log file (invisibly)
#' @export
create_log_file <- function(config,name="repec_update_") {
  log_file <- file.path(config$logs %||% tempdir(), paste0(name, format(Sys.time(), "%Y%m%d_%H%M%S"), ".log"))
  assign("log_file", log_file, envir = .GlobalEnv)
  invisible(log_file)
}

#' Log a message with timestamp and level
#'
#' @param level Character string indicating log level (e.g., "INFO", "ERROR", "WARN")
#' @param ... Message components to be concatenated
#' @export
log_msg <- function(level, ...) {
  ts <- format(Sys.time(), "%Y-%m-%d %H:%M:%S")
  line <- paste0("[", ts, "] ", "[", level, "] ", paste0(..., collapse = ""))
  message(line)
  write(line, file = log_file, append = TRUE)
}

#' Log an info message
#'
#' @param ... Message components to be concatenated
#' @export
info  <- function(...) log_msg("INFO", ...)

#' Log an error message
#'
#' @param ... Message components to be concatenated
#' @export
error <- function(...) log_msg("ERROR", ...)

#' Log a warning message
#'
#' @param ... Message components to be concatenated
#' @export
warn  <- function(...) log_msg("WARN", ...)
