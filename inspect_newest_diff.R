library(eddyspapersbackend)
library(dplyr)

config <- get_folder_config()

#' Path to the newest articles diff parquet
newest_articles_diff <- function(pqt_diff_folder = config$pqt_diff_folder) {
  files <- list.files(
    pqt_diff_folder,
    pattern = "^articles_diff_\\d{8}_\\d{6}_\\d{8}_\\d{6}\\.parquet$",
    full.names = TRUE
  )
  if (length(files) == 0) {
    stop("No articles diff files found in ", pqt_diff_folder)
  }
  files[which.max(file.mtime(files))]
}

#' Read an articles diff (newest by default), without the embeddings column
read_articles_diff <- function(path = newest_articles_diff()) {
  diff <- arrow::read_parquet(path)
  select(diff, -any_of("embeddings"))
}

#' Journal counts in a diff, optionally split by operation
diff_journal_counts <- function(diff, by_operation = FALSE) {
  if (by_operation && "operation" %in% names(diff)) {
    count(diff, operation, journal, sort = TRUE)
  } else {
    count(diff, journal, sort = TRUE)
  }
}

# Journal categories from best to worst (matches journals.csv `category`).
category_rank <- c(
  "Top 5 Journals",
  "Top Field Journals (A)",
  "AEJs",
  "General Interest",
  "Second in Field Journals (B)",
  "Other Journals",
  "Working Paper Series"
)

#' Highest-ranked category present among (NEW) rows of a diff
preferred_category <- function(diff, operation = "NEW") {
  rows <- diff
  if (!is.null(operation) && "operation" %in% names(rows)) {
    rows <- filter(rows, operation == !!operation)
  }
  present <- intersect(category_rank, unique(rows$category))
  if (length(present) == 0) NA_character_ else present[1]
}

#' Print a single paper (journal, title, authors, year, abstract) from a diff
show_diff_paper <- function(diff, journal_name = NULL, category_name = NULL,
                            operation = "NEW", n = 1) {
  rows <- diff
  if (!is.null(operation) && "operation" %in% names(rows)) {
    rows <- filter(rows, operation == !!operation)
  }
  if (!is.null(category_name)) {
    rows <- filter(rows, category == category_name)
  }
  if (!is.null(journal_name)) {
    rows <- filter(rows, journal == journal_name)
  }
  if (nrow(rows) == 0) {
    message("No matching rows.")
    return(invisible(NULL))
  }

  picked <- slice_head(rows, n = n)
  purrr::walk(seq_len(nrow(picked)), function(i) {
    r <- picked[i, ]
    cat("\n── paper ──\n")
    cat("Journal: ", r$journal,  "\n")
    cat("Title:   ", r$title,    "\n")
    cat("Authors: ", r$authors,  "\n")
    cat("Year:    ", r$year,     "\n\n")
    cat(r$abstract, "\n")
  })
  invisible(picked)
}

# --- run when sourced / Rscript'd ---
diff_path <- newest_articles_diff()
message("Newest diff: ", basename(diff_path))

a_diff <- read_articles_diff(diff_path)

cat("\n== Journals in diff ==\n")
print(diff_journal_counts(a_diff, by_operation = TRUE), n = Inf)

best_category <- preferred_category(a_diff)
cat("\n== Sample from best-ranked category present: ", best_category, "==\n")
show_diff_paper(a_diff, category_name = best_category)
