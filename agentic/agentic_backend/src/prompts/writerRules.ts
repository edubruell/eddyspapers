export const writerRulesPrompt = `\
## Writer rules

When a <clarification> block is present in the user message, it is authoritative: it records a
question the user was asked and their answer, and it refines the brief. Let it resolve any
ambiguity the brief left open — shape the script to match the answer.

Two feedback blocks can appear; they mean different things — never conflate them:
- <rejection> means your PREVIOUS CODE was invalid (an AST/SQL check failed). Fix the code; keep
  the strategy.
- <revision> (with a <previous_run>) means your previous code was valid and RAN, but the assessor
  judged the *strategy* underperformed. Change the APPROACH as the directive instructs — do not
  just resubmit the same plan. mode="replace" → the prior approach was wrong; re-derive it
  correctly (you may drop what it produced). mode="augment" → the prior results were fine and
  should stand; this pass should ADD new results (e.g. expand via citations, add a recency pass)
  on top of them. This is your one corrective pass, so make it count.

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

Multi-step / chained briefs (do it all in ONE script):
- You get exactly one script and one execution — there is no second round where you see results
  and write a follow-up. So when a brief needs intermediate results ("most-cited papers that cite X",
  "which of these WPs got published", "rank authors by their top-5 output"), CHAIN the verbs inside
  the single script: capture one query's output in a variable and feed it to the next.
- The data verbs compose with plain R. Iterate over a result's handles with purrr (\`map\`, \`list_c\`,
  \`compact\`), build follow-up SQL with \`sprintf\`/\`paste0\` (escape quotes via \`gsub("'", "''", x)\`),
  and join/rank with dplyr (\`left_join\`, \`arrange(desc(...))\`, \`slice_head\`). See the chained ZEW
  worked example above for the find → resolve-versions → rank-by-stats pattern.
- Guard every dependent step with \`if (nrow(prev) > 0) { ... }\` so an empty intermediate result
  degrades to an \`emit_note()\` instead of erroring.

Citation data is unreliable — rank with care:
- RePEc citation coverage is partial and noisy (see the API reference caveat). It under-counts
  recent papers and working papers badly, and misses many real citations everywhere.
- Do NOT rank a section purely by raw total_citations, and do NOT drop low-citation papers —
  a 2024 paper or a working paper with few citations may be the most important result.
- For "most successful / most impactful / most cited" briefs, use venue tier and recency as the
  primary success proxy and citations only as a secondary tie-breaker; when you do use citations,
  prefer citation_percentile (cohort-relative) over raw counts, and rank within a comparable cohort.

Journal-tier selection (you own this decision):
- The <filters> block usually contains NO categories — the user is not asked to pick tiers.
  When categories are absent, YOU choose the appropriate journal_filter tiers per section,
  inferred from the brief, using the tier vocabulary above. Empty <filters> does NOT mean
  "search every tier indiscriminately".
- Default to a quality-weighted published sweep (Top 5 / AEJs / Top Field (A), widening to
  General Interest / Second in Field (B) for thin topics) plus a separate recent
  Working-Paper Series pass when currency matters. Honour any tier, recency, or scope
  preference the user states in the brief.
- If the <filters> block DOES list categories, treat them as a hard restriction and stay
  within them.
`;
