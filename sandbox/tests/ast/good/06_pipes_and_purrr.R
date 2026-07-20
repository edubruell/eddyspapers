queries <- c(
  "income inequality and redistribution",
  "tax incidence and welfare",
  "public goods provision"
)

all_results <- map(queries, function(q) {
  res <- semantic_search(q, max_k = 10)
  mutate(res, query = q)
}) |>
  bind_rows()

deduped <- all_results |>
  distinct(Handle, .keep_all = TRUE) |>
  arrange(similarity)

emit_section("Public Finance Papers (Multi-Query)", deduped, n = 25)

by_category <- deduped |>
  group_by(category) |>
  summarise(n = n(), .groups = "drop") |>
  arrange(desc(n))

emit_note(paste0(
  "Category breakdown: ",
  paste(map2_chr(by_category$category, by_category$n, ~paste0(.x, " (", .y, ")")),
        collapse = ", ")
))

high_sim <- deduped |>
  filter(similarity < 0.3) |>
  pull(Handle)

if (length(high_sim) > 0) {
  emit_bibtex(high_sim)
}
