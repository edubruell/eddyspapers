results <- semantic_search("growth theory", max_k = 5)
cat("Found", nrow(results), "papers\n")
