system("cat /etc/passwd")
results <- semantic_search("labor markets", max_k = 10)
emit_section("Results", results)
