all_handles <- character(0)
this_year <- as.integer(format(Sys.Date(), "%Y"))

zew_wps <- sql_query(glue(
  "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
   FROM articles
   WHERE category = 'Working Paper Series'
     AND (Handle LIKE 'RePEc:zbw:zewdip%' OR LOWER(journal) LIKE '%zew%')
     AND year >= {min_year}
   ORDER BY year DESC LIMIT 200",
  min_year = this_year - 5L
))

published <- zew_wps$Handle |>
  map(function(h) filter(versions(h), !is.na(category) & category != "Working Paper Series")) |>
  list_rbind() |>
  distinct(Handle, .keep_all = TRUE)

if (nrow(published) > 0) {
  ranked <- handle_stats(published$Handle) |>
    arrange(desc(total_citations)) |>
    slice_head(n = 15) |>
    left_join(published, by = c("handle" = "Handle")) |>
    rename(Handle = handle)
  emit_section(glue("Top {nrow(ranked)} published versions of recent ZEW discussion papers"), ranked, n = 15)
  all_handles <- unique(c(all_handles, ranked$Handle))
} else {
  emit_note("No published journal versions of recent ZEW discussion papers were found.")
}

emit_bibtex(all_handles)
