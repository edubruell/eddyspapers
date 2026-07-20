results <- semantic_search("growth theory", max_k = 10)
writeLines(results$title, "/tmp/output.txt")
