emit_event <- function(payload_list) {
  if (is.null(.sandbox_state$fd3)) return(invisible(NULL))
  json_str <- jsonlite::toJSON(payload_list, auto_unbox = TRUE, null = "null")
  writeLines(json_str, con = .sandbox_state$fd3)
}

emit_progress <- function(label, current = NULL, total = NULL) {
  emit_event(list(type = "progress", label = label, current = current, total = total))
}

emit_note <- function(markdown) {
  emit_event(list(type = "note", markdown = markdown))
}

emit_bibtex <- function(handles) {
  .sandbox_state$bibtex_handles <- unique(c(.sandbox_state$bibtex_handles, handles))
  emit_event(list(type = "bibtex", handles = unique(.sandbox_state$bibtex_handles)))
}

emit_section <- function(title, df, n = 25, note = NULL) {
  top_df <- head(df, n)

  make_paper_event <- function(row) list(
    type       = "paper",
    handle     = row$Handle,
    title      = row$title,
    year       = row$year,
    authors    = row$authors,
    journal    = row$journal,
    category   = row$category,
    url        = paper_url(row$Handle, if ("url" %in% names(row)) row$url else NULL),
    similarity = if ("similarity" %in% names(row)) row$similarity else NULL,
    abstract   = if ("abstract" %in% names(row)) row$abstract else NULL
  )

  purrr::walk(seq_len(nrow(top_df)), function(i) {
    h <- top_df$Handle[[i]]
    if (!h %in% .sandbox_state$seen_handles) {
      .sandbox_state$seen_handles <- c(.sandbox_state$seen_handles, h)
      emit_event(make_paper_event(top_df[i, , drop = FALSE]))
    }
  })

  emit_event(list(type = "section", title = title, handles = top_df$Handle, note = note))
}
