author_name <- "Acemoglu"

author_papers <- sql_query(
  "SELECT Handle, title, year, authors, journal, category, url, abstract, bib_tex
   FROM articles
   WHERE authors LIKE ?
   ORDER BY year DESC",
  params = list(paste0("%", author_name, "%"))
)

emit_note(paste0("Found ", nrow(author_papers), " papers with author matching '", author_name, "'."))
emit_section(paste0("Papers by ", author_name), author_papers, n = 20)

if (nrow(author_papers) > 0) {
  handles <- author_papers$Handle
  stats   <- handle_stats(handles)
  top_cited <- stats |>
    arrange(desc(total_citations)) |>
    head(5)
  emit_note(paste0("Most-cited paper: ", top_cited$handle[[1]],
                   " with ", top_cited$total_citations[[1]], " citations."))
}
