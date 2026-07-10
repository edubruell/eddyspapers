// Server-level MCP instructions (01_design.md §7, §C3 layer 1) — one paragraph the
// client shows its model on connect. States what the corpus is, when to reach for
// the fat pipeline (lit_search) vs the cheap tools, and the one rule that most
// improves results (semantic queries as prose).

export const MCP_INSTRUCTIONS = `This server searches a corpus of ~455k RePEc/EconLit economics papers and ~88k registered authors (the RePEc Author Service), snapshotted from the same database that powers econpapers.eduard-bruell.de.

For a synthesised answer from one call, use lit_search — it writes and runs a tailored search script and returns a mini-review (synthesis + BibTeX + CSV + structured papers). For surgical lookups where you want raw rows, prefer the cheap tools below (no LLM, faster):
- corpus_context — free; returns the valid category/journal filter values, corpus sizes, and query-writing guidance. Call it before guessing filter values.
- find_papers — semantic vector search. Write the query as 3-6 sentences of abstract-style prose describing mechanism, method, and context — NOT keyword labels. This single rule drives result quality more than any filter.
- keyword_search — literal LIKE search for exhaustive term sweeps and known-title/phrase lookups.
- find_people — find economists by research area (topic overlap rolled up from their papers).
- verify_references — batch-check a bibliography against the corpus (three-tier matching + citation stats + mismatch flags).

Paper details (citations, versions, stats) are resources under agenticsearch://papers/{handle}; a completed lit_search run is readable under agenticsearch://searches/{id}.`;
