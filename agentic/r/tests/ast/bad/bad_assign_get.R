assign("my_results", semantic_search("trade", max_k = 5))
results <- get("my_results")
emit_section("Results", results)
