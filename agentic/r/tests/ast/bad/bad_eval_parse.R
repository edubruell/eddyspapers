cmd <- "semantic_search('trade', max_k = 5)"
results <- eval(parse(text = cmd))
emit_section("Results", results)
