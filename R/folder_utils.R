folder_reference_factory <- function(.target_folder) {
  stopifnot("Please set the path to a .target_folder" = !is.null(.target_folder))
  
  function(...) {
    if (!missing(..1)) {
      abs <- rprojroot:::is_absolute_path(..1)
      if (all(abs)) {
        return(fs::path(...))
      }
      if (any(abs)) {
        stop("Combination of absolute and relative paths not supported.", 
             call. = FALSE)
      }
    }
    rprojroot:::path(.target_folder, ...)
  }
}

get_folder_refs <- function(config = NULL) {
  if (is.null(config)) {
    config_path <- here::here("R", "config.R")
    if (file.exists(config_path)) {
      source(config_path, local = TRUE)
      config <- get_folder_config()
    } else {
      stop("No config provided and config.R not found. Please create R/config.R or pass a config object.")
    }
  }
  
  list(
    data_root = folder_reference_factory(config$data_root),
    repec = folder_reference_factory(config$repec_folder),
    rds = folder_reference_factory(config$rds_folder),
    pqt = folder_reference_factory(config$pqt_folder),
    db = folder_reference_factory(config$db_folder)
  )
}
