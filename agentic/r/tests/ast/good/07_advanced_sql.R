cited_counts <- sql_query(
  "SELECT cited, COUNT(*) AS n_citations
   FROM cit_internal
   GROUP BY cited
   ORDER BY n_citations DESC
   LIMIT 50"
)

if (nrow(cited_counts) > 0) {
  handles <- cited_counts$cited
  placeholders <- paste(rep("?", length(handles)), collapse = ", ")
  meta <- sql_query(
    paste0("SELECT Handle, title, year, authors, journal, category, url, abstract, bib_tex
            FROM articles
            WHERE Handle IN (", placeholders, ")"),
    params = as.list(handles)
  )

  enriched <- cited_counts |>
    inner_join(meta, by = c("cited" = "Handle")) |>
    rename(Handle = cited) |>
    arrange(desc(n_citations))

  emit_section("Most-Cited Papers (Internal Network)", enriched, n = 20)
}

recent_active <- sql_query(
  "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category,
          a.url, a.abstract, a.bib_tex,
          COUNT(ci.citing) AS recent_cites
   FROM articles a
   JOIN cit_internal ci ON a.Handle = ci.cited
   WHERE a.year >= 2010
   GROUP BY a.Handle, a.title, a.year, a.authors, a.journal,
            a.category, a.url, a.abstract, a.bib_tex
   HAVING COUNT(ci.citing) >= 5
   ORDER BY recent_cites DESC"
)

emit_section("Active Papers (2010+, 5+ Internal Citations)", recent_active, n = 20)
