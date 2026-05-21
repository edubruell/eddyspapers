library(ggplot2)
results <- semantic_search("trade policy", max_k = 10)
emit_section("Results", results)
