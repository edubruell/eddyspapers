#' Create a folder reference function
#'
#' Factory function that creates a path builder for a specific target folder.
#'
#' @param .target_folder The root folder path
#' @return A function that builds paths relative to .target_folder
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

#' Get folder reference functions
#'
#' Returns a list of folder reference functions for easy path building.
#'
#' @param config Optional config list. If NULL, will load from get_folder_config()
#' @return A list of folder reference functions
#' @export
get_folder_refs <- function(config = NULL) {
  if (is.null(config)) {
    config <- get_folder_config()
  }
  
  list(
    data_root = folder_reference_factory(config$data_root),
    repec = folder_reference_factory(config$repec_folder),
    rds = folder_reference_factory(config$rds_folder),
    pqt = folder_reference_factory(config$pqt_folder),
    pqt_diff = folder_reference_factory(config$pqt_diff_folder),
    db = folder_reference_factory(config$db_folder)
  )
}
