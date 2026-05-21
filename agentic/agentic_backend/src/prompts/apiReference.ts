export const apiReferencePrompt = `\
## eddysearch.sandbox API reference

All verbs are pre-attached. Do not call library(). Do not use DBI::dbConnect() or any
package not listed here. Every call to a data verb emits a progress event automatically.

---

### Data verbs

semantic_search(query, max_k = 30, min_year = NULL, journal_filter = NULL, journal_name = NULL)
  Vector similarity search over the articles database. Returns a tibble.
  - query: dense prose describing the mechanism or phenomenon (3–6 sentences). NOT keywords.
    See "Semantic query writing guide" section of the system prompt.
  - max_k: number of results to return (≤ 30 for broad sweeps, ≤ 15 for WP/recent passes)
  - min_year: integer filter, e.g. 2015L
  - journal_filter: character vector of category names, e.g. c("Top 5", "AEJ", "Top Field A")
  - journal_name: substring match on journal name, e.g. "Journal of Labor Economics"
  Returns columns: Handle, title, year, authors, journal, category, url, bib_tex, abstract, similarity
  Lower similarity = closer match (cosine distance).

  Examples:
    top <- semantic_search(
      "How do minimum wage increases affect employment and hours worked in low-wage labor markets?",
      max_k = 20, journal_filter = c("Top 5", "AEJ", "Top Field A"), min_year = 2010L
    )
    wps <- semantic_search(
      "Natural experiments and regression discontinuity designs to identify minimum wage effects",
      max_k = 15, journal_filter = c("Working Paper Series"), min_year = 2018L
    )

sql_query(sql, params = list())
  Read-only SELECT against these tables: articles, cit_all, cit_internal, handle_stats,
  journals, versions, bib_coupling. Parser-validated — COPY/ATTACH/DDL/PRAGMA are rejected.
  LIMIT is auto-injected if absent (capped at 5000). Use for keyword chains, SQL aggregations,
  and multi-table joins that semantic_search cannot express.
  Returns a tibble.

  Examples:
    # keyword sweep over a journal
    jole <- sql_query(
      "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
       FROM articles
       WHERE LOWER(journal) LIKE '%journal of labor economics%'
         AND (LOWER(title) LIKE '%minimum wage%' OR LOWER(title) LIKE '%wage floor%')
       ORDER BY year DESC LIMIT 50"
    )
    # top-cited papers in a category
    top_cited <- sql_query(
      "SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url,
              hs.total_citations, hs.citation_percentile
       FROM articles a
       JOIN handle_stats hs ON a.Handle = hs.handle
       WHERE a.category IN ('Top 5', 'AEJ')
         AND a.year >= 2000
       ORDER BY hs.total_citations DESC LIMIT 30"
    )

cites(handle, limit = 50)
  Papers cited by the given handle (internal graph only — both ends in our DB).
  Returns tibble: Handle, title, year, authors, journal, category, url, abstract, bib_tex

citedby(handle, limit = 50)
  Papers that cite the given handle (internal graph only).
  Returns tibble: Handle, title, year, authors, journal, category, url, abstract, bib_tex

  Example — find co-citation cluster:
    refs  <- cites("repec:aea:aecrev:v:104:y:2014:i:6:p:1477-1523", limit = 30)
    citers <- citedby("repec:aea:aecrev:v:104:y:2014:i:6:p:1477-1523", limit = 30)

handle_stats(handles)
  Precomputed citation and impact statistics for a vector of handles.
  Returns tibble: handle, pub_year, total_citations, internal_citations, total_references,
                  citations_per_year, citation_percentile (0–1), citations_by_year (JSON),
                  median_citer_percentile, weighted_citations, top5_citer_share,
                  top_citing_journal, citer_category_counts, citer_category_shares

versions(handle)
  All known version links for a paper (working paper → journal, etc.).
  Returns tibble: canonical_handle, handle, type

bib_for(handles)
  BibTeX entries for a vector of handles.
  Returns tibble: Handle, bib_tex

journals()
  Full journal metadata table.
  Returns tibble: journal_code, journal, archive, category, ...

categories()
  Distinct category values present in the articles table.
  Returns tibble: category

paper_url(handle, url = NULL)
  Construct an IDEAS/RePEC fallback URL for a handle. If url is non-empty, returns it unchanged.
  Prefer the url column from semantic_search or sql_query results — only call this as a fallback.

---

### Output verbs

emit_section(title, df, n = 25, note = NULL)
  Emit a named result section. df must have columns: Handle, title, year, authors, journal,
  category, url (and optionally abstract, similarity). Deduplicates against already-emitted
  handles across the script run — safe to call multiple times with overlapping result sets.
  Each new paper emits a paper event; then a section event groups the handles under title.

emit_bibtex(handles)
  Collect handles for BibTeX export. Call with all_handles at the end of the script.
  Accumulates across calls — safe to call mid-script too.

emit_note(markdown)
  Emit a freeform markdown note visible in the UI. Use for: strategy comments, scope notes,
  caveats about data gaps. Keep brief (1–4 sentences).

emit_progress(label, current = NULL, total = NULL)
  Emit a progress message. All data verbs call this automatically; you only need it for
  long custom loops or when you want to mark a logical phase boundary.

---

### Allowed glue (base R + tidyverse)

You may use: base R, dplyr, tidyr, stringr, purrr, glue, lubridate.
These packages are pre-attached and available without library().

Useful patterns:
  all_handles <- character(0)                             # accumulate handles
  all_handles <- unique(c(all_handles, result$Handle))    # add section results
  bind_rows(df1, df2) |> distinct(Handle, .keep_all = TRUE)  # merge + dedup

---

### Hard-rejected calls (AST allowlist — these will fail validation)

- library() / require() — the verbs are pre-attached; loading extra packages bypasses the allowlist
- cat() / writeLines() / write.csv() / sink() — use emit_* for all output; file writes are blocked
- system() / system2() / shell() — shell access is not available in the sandbox
- eval(parse(...)) / do.call("eval", ...) — dynamic eval is blocked
- DBI::dbConnect() — the connection is managed by the sandbox; do not open your own
- Sys.setenv() / Sys.getenv() — environment manipulation is blocked
- readLines() / readRDS() / read.csv() on arbitrary paths — filesystem reads are blocked
- source() — script sourcing is blocked
`;
