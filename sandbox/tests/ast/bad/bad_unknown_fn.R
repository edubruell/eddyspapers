results <- semantic_search("climate economics", max_k = 10)
cleaned <- my_custom_cleaner(results)
emit_section("Results", cleaned)
