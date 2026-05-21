seed <- semantic_search("monetary policy transmission mechanism", max_k = 5)
emit_section("Seed Papers", seed, n = 5)

top_handle <- seed$Handle[[1]]

cited_papers <- cites(top_handle, limit = 30)
emit_section("Papers Cited by Top Result", cited_papers, n = 20)

citing_papers <- citedby(top_handle, limit = 30)
emit_section("Papers Citing Top Result", citing_papers, n = 20)

stats <- handle_stats(seed$Handle)
emit_note(paste0("Citation stats retrieved for ", nrow(stats), " seed papers."))
