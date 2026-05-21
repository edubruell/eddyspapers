fmt_row <- function(df, i) {
  row <- df[i, , drop = FALSE]
  paste0(
    "[", i, "] ", row$title, " (", row$year, ")\n",
    "     ", row$authors, "\n",
    "     ", row$journal, " | ", row$category, "\n",
    "     Handle: ", row$Handle
  )
}

format_results <- function(df, n = 25) {
  results <- purrr::map_chr(seq_len(min(n, nrow(df))), function(i) fmt_row(df, i))
  paste(results, collapse = "\n\n")
}
