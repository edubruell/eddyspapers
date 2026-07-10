// Server-level MCP instructions (01_design.md §7, §C3 layer 1) — one paragraph the
// client shows its model on connect. States what the corpus is, when to reach for
// the fat pipeline vs the cheap tools, and the one rule that most improves results
// (semantic queries as prose). lit_search lands in Phase 3; until then the cheap
// tools are the whole surface, so this copy leads with them.

export const MCP_INSTRUCTIONS = `This server searches a corpus of ~455k RePEc/EconLit economics papers and ~88k registered authors (the RePEc Author Service), snapshotted from the same database that powers econpapers.eduard-bruell.de.

Tools, cheapest first:
- corpus_context — free; returns the valid category/journal filter values, corpus sizes, and query-writing guidance. Call it before guessing filter values.
- find_papers — semantic vector search. Write the query as 3-6 sentences of abstract-style prose describing mechanism, method, and context — NOT keyword labels. This single rule drives result quality more than any filter.
- keyword_search — literal LIKE search for exhaustive term sweeps and known-title/phrase lookups.
- find_people — find economists by research area (topic overlap rolled up from their papers).
- verify_references — batch-check a bibliography against the corpus (three-tier matching + citation stats + mismatch flags).

Prefer the cheap tools for direct lookups; they use no LLM. Paper details (citations, versions, stats) are available as resources under agenticsearch://papers/{handle}.`;
