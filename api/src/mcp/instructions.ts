// Server-level MCP instructions (01_design.md §7, §C3 layer 1) — one paragraph the
// client shows its model on connect. States what the corpus is, when to reach for
// the fat pipeline (lit_search) vs the cheap tools, which half of lit_search is gated,
// and the one rule that most improves results (semantic queries as prose).

export const MCP_INSTRUCTIONS = `This server searches a corpus of ~455k RePEc/EconLit economics papers and ~88k registered authors (the RePEc Author Service), snapshotted from the same database that powers econpapers.eduard-bruell.de.

To sweep a whole literature in one call, use lit_search — it writes and runs a tailored search script server-side and returns the papers, BibTeX, CSV, section structure and the script itself. It returns RESULTS ONLY by default: you write the review from the rows it gives you. Asking the server to write the review instead (synthesize=true) requires an API key granted the 'lit_search_synth' scope, and is refused without it — so treat script-only as the normal mode, not a degraded one. A large run is handed back as a HANDLE rather than inlined — the result carries the citable digest of every paper plus a search_id, and you pull the BibTeX, CSV, full records or script from it with fetch_search (which also re-reads any earlier run, free).

For surgical lookups where you want raw rows, prefer the cheap tools below (no LLM, faster):
- corpus_context — free; returns the valid category/journal filter values, corpus sizes, and query-writing guidance. Call it before guessing filter values.
- find_papers — semantic vector search. Write the query as 3-6 sentences of abstract-style prose describing mechanism, method, and context — NOT keyword labels. This single rule drives result quality more than any filter.
- keyword_search — literal LIKE search for exhaustive term sweeps and known-title/phrase lookups.
- find_people — find economists by research area (topic overlap rolled up from their papers).
- verify_references — batch-check a bibliography against the corpus (three-tier matching + citation stats + mismatch flags). Its author_lastnames field is SEMICOLON-separated last names only ("Acemoglu; Robinson") — commas and first names break matching.

Every tool documents its own field conventions in its input schema; read them before guessing. The same conventions, plus the REST equivalents of these tools, are served as JSON at GET /docs.

Paper results and details carry an optional \`openalex\` block (matched by DOI, ~half the corpus): a retraction flag, an open-access full-text link, and field-weighted citation impact. Treat its absence as "unmatched", not "low impact", and always flag \`is_retracted\` papers rather than citing them as sound.

Paper details (citations, versions, stats, OpenAlex metrics) are resources under agenticsearch://papers/{handle}; a completed lit_search run is readable under agenticsearch://searches/{id} (same cuts as fetch_search, for clients that support resources).`;
