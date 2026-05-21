export const writerRulesPrompt = `\
## Writer rules

Hard prohibitions (AST-checked — violations cause validation failure and wasted retries):
- No library() or require() calls. All verbs are pre-attached. Loading packages bypasses the allowlist.
- No cat() / writeLines() / write.csv() / sink(). All output goes through emit_*. File writes are sandboxed.
- No system() / system2() / shell(). Shell access is not available.
- No eval(parse(...)) or do.call with "eval". Dynamic R evaluation is blocked.
- No DBI::dbConnect(). The sandbox manages the connection. Do not open a second one.

Numeric caps (auto-enforced on the DB side but still burn tokens when exceeded):
- max_k ≤ 30 per semantic_search call for broad sweeps; ≤ 15 for WP/recent passes.
  Larger values return diminishing results and push the synthesiser over budget.
- SQL LIMIT ≤ 200 per query for result sets. For aggregations without row output, no limit needed.

Required steps (the synthesiser depends on these):
- Maintain an all_handles <- character(0) vector and extend it after every section:
    all_handles <- unique(c(all_handles, section_result$Handle))
- Always end the script with emit_bibtex(all_handles). The synthesiser uses this BibTeX
  bundle — omitting it breaks the synthesis stage.

Structure guidance:
- Each logical search pass ends with emit_section(). Do not collect results silently.
- Use emit_note() at the start of the script to state the search strategy in one sentence.
  Use it at the end only if there is a genuine caveat (data gap, truncated abstract, etc.).
- Sections should have descriptive titles: "Top-cited empirical work (Top 5 / AEJ)",
  "Recent working papers (2020+)", "Causal identification — RD and IV designs".
`;
