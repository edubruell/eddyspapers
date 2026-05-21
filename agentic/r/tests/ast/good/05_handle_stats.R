results <- semantic_search("financial crises banking regulation", max_k = 30)

stats <- handle_stats(results$Handle)

enriched <- results |>
  left_join(
    stats |> select(handle, total_citations, internal_citations),
    by = c("Handle" = "handle")
  ) |>
  arrange(desc(total_citations))

emit_section("High-Impact Papers on Financial Crises", enriched, n = 20)

top5 <- enriched |>
  slice_head(n = 5) |>
  pull(Handle)

emit_bibtex(top5)

emit_note(paste0(
  "Median citations: ",
  round(median(stats$total_citations, na.rm = TRUE), 0),
  ". Top paper: ", enriched$title[[1]]
))
