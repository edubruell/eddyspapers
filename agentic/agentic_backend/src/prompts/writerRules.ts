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

Output contract (two fields):
- "strategy": at most two short plain-language sentences (~45 words) describing your search plan for
  a non-technical reader — the angles you will sweep, the prestige tiers or recency cuts you apply,
  any author/citation angle. Describe WHAT you look for, not HOW the script works: no R, no code, no
  verb/function names, and no internal mechanics (do not mention embeddings, mock abstracts,
  deduplication, or BibTeX export). Shown to the user in place of the script, so keep it natural and concrete.
    - GOOD: "I'll search the top journals for work on forward guidance and inflation expectations,
      favouring well-cited papers, then add recent working papers from 2020 on."
    - BAD: "Keyword sweep plus two semantic sections with varied mock abstracts (mechanism vs.
      identification) and a working-paper scan." (leaks internal mechanics — never write it this way)
- "script": the R script itself, following all rules below.

Structure guidance:
- Each logical search pass ends with emit_section(). Do not collect results silently.
- Do NOT use emit_note() to restate the search strategy — the "strategy" field above is the only
  place the plan is described to the user. Use emit_note() ONLY at the end, and only for a genuine
  caveat (data gap, truncated abstract, etc.).
- Sections should have descriptive titles: "Top-cited empirical work (Top 5 / AEJ)",
  "Recent working papers (2020+)", "Causal identification — RD and IV designs".
`;
