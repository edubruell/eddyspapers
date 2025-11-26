r_has_name <- function(.x, .name) {
  if (is.list(.x)) {
    return(.name %in% names(.x) || any(sapply(.x, r_has_name, .name = .name)))
  }
  FALSE
}

#' Parse ReDIF file using Perl backend
#'
#' Parses a ReDIF format file using the Perl ReDIF library.
#'
#' @param path Path to ReDIF file
#' @param script_path Path to Perl parsing script
#' @param simplify Unused parameter (kept for compatibility)
#' @param error_on_fail If TRUE, stops on parse errors. If FALSE, returns NULL with warning
#' @return Parsed ReDIF data as nested list, or NULL on failure
#' @export
parse_redif_perl <- function(path,
                             script_path = "parse_redif_simple.pl",
                             simplify = TRUE,
                             error_on_fail = FALSE) {
  stopifnot(file.exists(path), file.exists(script_path))
  
  lib <- path.expand("~/.perl5/lib/perl5")
  arch <- file.path(lib, "darwin-thread-multi-2level")
  Sys.setenv(PERL5LIB = paste(c(lib, arch), collapse = ":"))
  
  result <- tryCatch({
    output <- system2("perl", args = c(script_path, shQuote(path)), 
                      stdout = TRUE, stderr = TRUE)
    
    json_start <- which(stringr::str_detect(output, "^\\s*\\["))
    if (length(json_start) == 0) stop("No valid JSON found in output.")
    
    json_txt <- paste(output[json_start:length(output)], collapse = "\n")
    
    jsonlite::fromJSON(json_txt, simplifyVector = FALSE)
  }, error = function(e) {
    if (error_on_fail) stop(e)
    warning(sprintf("Failed to parse: %s\n%s", path, e$message))
    NULL
  })
  
  return(result)
}

#' Post-process a parsed ReDIF entry
#'
#' Extracts and cleans fields from a parsed ReDIF entry into a standard format.
#'
#' @param entry Parsed ReDIF entry (nested list)
#' @return Cleaned entry as list, or NULL if invalid
#' @export
post_process_entry <- function(entry) {
  handle <- entry$ID
  if (is.null(entry$ID)) {
    return(NULL)
  }
  
  handle_entries <- stringr::str_split(handle, ":")
  if (length(handle_entries[[1]]) > 3) {
    archive      <- handle_entries |> purrr::map_chr(2)
    journal_code <- handle_entries |> purrr::map_chr(3)
  } else {
    warning("ENTRY INVALID SKIPPED")
    return(NULL)
  }
  
  if (!r_has_name(entry$author, "name")) {
    warning("INVALID AUTHOR FIELD - SKIPPED")
    return(NULL)
  }
  
  authors_list <- entry$author |>
    purrr::keep(~r_has_name(.x, "name")) |>
    purrr::map_chr(~{
      name_field <- .x$name[[1]]
      if (is.null(.x$name[[1]])) {
        name_field <- ""
      }
      name_field
    }) |>
    list()
  
  authors_string <- unlist(authors_list) |> stringr::str_c(collapse = "; ")
  title <- entry$title[[1]]
  
  abstract <- ""
  if (!is.null(entry$abstract)) {
    abstract <- entry$abstract[[1]]
  }
  
  if (entry$TYPE == "ReDIF-Article 1.0") {
    year <- entry$year[[1]]
    is_series <- FALSE
  }
  if (entry$TYPE == "ReDIF-Paper 1.0") {
    cr <- entry$`creation-date`
    year <- stringr::str_sub(cr, 1, 4)
    is_series <- TRUE
  }
  if (entry$TYPE == "ReDIF-Chapter 1.0") {
    year <- entry$year[[1]]
    is_series <- FALSE
  }
  
  file <- tibble::tibble()
  if (!is.null(entry$file)) {
    file <- entry$file |>
      purrr::map_dfr(tibble::as_tibble)
    
    file_fields <- colnames(file)
    file_fields <- file_fields[file_fields %in% c("format", "url")]
    
    file <- file |>
      tidyr::unnest(cols = all_of(file_fields)) |>
      dplyr::select(all_of(file_fields))
  }
  
  jel_list <- ""
  jel_char <- ""
  if (!is.null(entry$`classification-jel`)) {
    jel_list <- stringr::str_split(entry$`classification-jel`, pattern = " ") |> 
      unlist()
    jel_char <- entry$`classification-jel` |> unlist() |> 
      stringr::str_c(collapse = " ")
  }
  
  journal_internal <- ""
  if (!is.null(entry$journal)) {
    journal_internal <- entry$journal[[1]]
  }
  volume <- ""
  if (!is.null(entry$volume)) {
    volume <- entry$volume[[1]]
  }
  issue <- ""
  if (!is.null(entry$issue)) {
    issue <- entry$issue[[1]]
  }
  pages <- ""
  if (!is.null(entry$pages)) {
    pages <- entry$pages[[1]]
  }
  month <- ""
  if (!is.null(entry$month)) {
    month <- entry$month[[1]]
  }
  doi <- ""
  if (!is.null(entry$doi)) {
    doi <- entry$doi[[1]]
  }
  number <- ""
  if (!is.null(entry$number)) {
    number <- entry$number[[1]]
  }
  
  entry_type <- if (is_series) "techreport" else "article"
  
  first_author <- authors_list[[1]][1] |> 
    stringr::str_split(" ") |> 
    purrr::map_chr(last)
  bib_key <- paste0(tolower(first_author), year)
  
  bib_tex <- glue::glue("@{entry_type}{{{bib_key},
  author = {{{stringr::str_replace_all(authors_string, '; ', ' and ')}}},
  title = {{{title}}},
  year = {{{year}}},
  {if(volume != '') glue::glue('volume = {{{volume}}},') else ''}
  {if(issue != '') glue::glue('number = {{{issue}}},') else ''}
  {if(pages != '') glue::glue('pages = {{{pages}}},') else ''}
  {if(month != '') glue::glue('month = {{{month}}},') else ''}
  {if(doi != '') glue::glue('doi = {{{doi}}},') else ''}
  {if(is_series) glue::glue('institution = {{{journal_code}}},') else glue::glue('journal = {{{journal_internal}}},')}
  note = {{{handle}}}
}}") |> as.character()
  
  tibble::tibble(
    Handle = handle,
    archive = archive,
    journal_code = journal_code,
    authors = authors_list,
    authors_string = authors_string,
    title = title,
    abstract = abstract,
    year = year,
    is_series = is_series,
    file = list(file),
    jel_list = list(jel_list),
    jel_char = jel_char,
    volume = volume,
    issue = issue,
    pages = pages,
    month = month,
    doi = doi,
    number = number,
    bib_tex = bib_tex
  )
}

#' Find all ReDIF files in RePEc folder
#'
#' Scans the RePEc folder structure and returns metadata for all ReDIF files.
#'
#' @param repec_folder Path to RePEc folder. Defaults to config$repec_folder
#' @return Tibble with archive, journal_code, repo_id, and file paths
find_redif_files <- function(repec_folder = NULL) {
  if (is.null(repec_folder)) {
    config <- get_folder_config()
    repec_folder <- config$repec_folder
  }
  
  journal_base <- list.dirs(repec_folder, full.names = FALSE) |>
    purrr::keep(~stringr::str_detect(.x, "/")) |>
    purrr::discard(~{.x == "cpd/conf"})
  
  journal_base |>
    purrr::map_dfr(~{
      archive <- stringr::str_split(.x, "/") |> purrr::map_chr(1)
      journal <- stringr::str_split(.x, "/") |> purrr::map_chr(2)
      tibble::tibble(
        archive = archive,
        journal_code = journal,
        repo_id = paste0(archive, "_", journal_code),
        file = list.files(file.path(repec_folder, .x),
                          pattern = "\\.(redif|rdf)$",
                          full.names = TRUE)
      )
    })
}

#' Get parse status for ReDIF files
#'
#' Compares ReDIF file timestamps with RDS files to determine what needs parsing.
#'
#' @param redif_files Data frame from find_redif_files()
#' @param rds_folder Path to RDS output folder. Defaults to config$rds_folder
#' @return Tibble with parse status and needs_parse flag
get_parse_status <- function(redif_files, rds_folder = NULL) {
  if (is.null(rds_folder)) {
    config <- get_folder_config()
    rds_folder <- config$rds_folder
  }
  
  if (!dir.exists(rds_folder)) {
    dir.create(rds_folder, recursive = TRUE, showWarnings = FALSE)
  }
  
  redif_files |>
    dplyr::mutate(
      redif_mtime = file.info(file)$mtime,
      rds_file = file.path(rds_folder, paste0(repo_id, ".rds")),
      rds_exists = file.exists(rds_file),
      rds_mtime = ifelse(rds_exists, file.info(rds_file)$mtime, as.POSIXct(0))
    ) |>
    dplyr::mutate(
      needs_parse = (!rds_exists) | (redif_mtime > rds_mtime)
    )
}

#' Parse and save ReDIF files for a repository
#'
#' Parses all ReDIF files for a given repository and saves result as RDS.
#'
#' @param repo_files Data frame with file paths for one repository
#' @param rds_folder Path to RDS output folder. Defaults to config$rds_folder
#' @param script_path Path to Perl parsing script
#' @return Parsed data invisibly
parse_and_save_redif <- function(repo_files, 
                                 rds_folder = NULL,
                                 script_path = "parse_redif_simple.pl") {
  if (is.null(rds_folder)) {
    config <- get_folder_config()
    rds_folder <- config$rds_folder
  }
  
  repo <- unique(repo_files$repo_id)
  cat("Parsing ReDIF for:", repo, "\n")
  
  parsed_data <- repo_files$file |>
    purrr::map_dfr(~{
      cat("-> File:", .x, "\n")
      
      parsed_redif <- parse_redif_perl(.x, script_path = script_path)
      
      parsed_redif |>
        purrr::map_dfr(post_process_entry)
    })
  
  saveRDS(parsed_data, file.path(rds_folder, paste0(repo, ".rds")))
  
  invisible(parsed_data)
}

#' Parse all journals that need updating
#'
#' Main function to parse all ReDIF files that are new or updated.
#'
#' @param repec_folder Path to RePEc folder. Defaults to config$repec_folder
#' @param rds_folder Path to RDS output folder. Defaults to config$rds_folder
#' @param script_path Path to Perl parsing script
#' @param skip_today If TRUE, skips repos already parsed today
#' @return Data frame of files that were parsed invisibly
#' @export
parse_all_journals <- function(repec_folder = NULL,
                               rds_folder = NULL,
                               script_path = "parse_redif_simple.pl",
                               skip_today = TRUE) {
  redif_files <- find_redif_files(repec_folder)
  parse_status <- get_parse_status(redif_files, rds_folder)
  
  to_parse <- parse_status |>
    dplyr::filter(needs_parse)
  
  if (skip_today) {
    updated_today <- fs::dir_info(rds_folder) |>
      dplyr::filter(lubridate::as_date(modification_time) == lubridate::today()) |>
      dplyr::transmute(repo = stringr::str_remove(path, rds_folder) |>
                         stringr::str_remove("/") |>
                         stringr::str_remove(".rds")) |>
      dplyr::pull(repo)
    
    to_parse <- to_parse |>
      dplyr::filter(!(repo_id %in% updated_today))
  }
  
  paper_archives <- to_parse |>
    dplyr::group_by(repo_id) |>
    dplyr::group_split()
  
  paper_archives |>
    purrr::walk(~parse_and_save_redif(.x, rds_folder, script_path))
  
  invisible(to_parse)
}
