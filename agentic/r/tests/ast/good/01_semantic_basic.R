results <- semantic_search("fiscal policy and government spending", max_k = 20)
emit_section("Fiscal Policy Papers", results, n = 15)
emit_note("Search complete. Papers sorted by semantic similarity.")
