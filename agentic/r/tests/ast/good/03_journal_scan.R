jnl <- journals()
top_journals <- jnl |>
  filter(!is.na(journal)) |>
  arrange(desc(n)) |>
  head(10)

emit_note(paste0("Top 10 journals by article count: ",
                 paste(top_journals$journal, collapse = ", ")))

codes <- top_journals$journal_code
placeholders <- paste(rep("?", length(codes)), collapse = ", ")
sql <- paste0(
  "SELECT Handle, title, year, authors, journal, category, url, abstract, bib_tex
   FROM articles
   WHERE journal_code IN (", placeholders, ")
   AND year >= 2015
   ORDER BY year DESC"
)

recent <- sql_query(sql, params = as.list(codes))
emit_section("Recent Papers in Top Journals", recent, n = 25)
