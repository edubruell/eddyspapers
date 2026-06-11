export const apiReferencePrompt = `\
## eddysearch.sandbox API reference

All verbs are pre-attached. Do not call library(). Do not use DBI::dbConnect() or any
package not listed here. Every call to a data verb emits a progress event automatically.

---

### Data verbs

semantic_search(query, max_k = 30, min_year = NULL, journal_filter = NULL, journal_name = NULL)
  Vector similarity search over the articles database. Returns a tibble.
  - query: a mock abstract — 2–4 sentences written as if they were the abstract of an ideal
    result paper. NOT a question, NOT keywords. See "Semantic query writing guide".
  - max_k: number of results to return (≤ 30 for broad sweeps, ≤ 15 for WP/recent passes)
  - min_year: integer filter, e.g. 2015L
  - journal_filter: character vector of category names, e.g. c("Top 5 Journals", "AEJs", "Top Field Journals (A)")
  - journal_name: substring match on journal name, e.g. "Journal of Labor Economics"
  Returns columns: Handle, title, year, authors, journal, category, url, bib_tex, abstract, similarity
  Lower similarity = closer match (cosine distance).

  Examples:
    top <- semantic_search(
      "This paper studies the employment effects of minimum wage increases in low-wage labor
       markets using linked employer-employee administrative data. We find that higher wage
       floors reduce employment margins through hours reductions and delayed hiring, with
       larger effects among part-time workers in sectors near the wage floor.",
      max_k = 20, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)"), min_year = 2010L
    )
    wps <- semantic_search(
      "Using a regression discontinuity design around the minimum wage threshold, this paper
       estimates bunching in the wage distribution and identifies employment effects. We exploit
       cross-regional variation in wage bite to isolate causal impacts on job creation.",
      max_k = 15, journal_filter = c("Working Paper Series"), min_year = 2018L
    )

sql_query(sql, params = list())
  Read-only SELECT against these tables: articles, cit_all, cit_internal, handle_stats,
  journals, version_links, bib_coupling. Parser-validated — COPY/ATTACH/DDL/PRAGMA are rejected.
  version_links has columns (source, target, type) — directed version edges between handles;
  join to articles on target/source for metadata. Prefer the versions() verb below for lookups.
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
       WHERE a.category IN ('Top 5 Journals', 'AEJs')
         AND a.year >= 2000
       ORDER BY hs.total_citations DESC LIMIT 30"
    )

### Citation data — partial and noisy, never treat as ground truth

RePEc citation coverage is incomplete and uneven. The citation graph (cites/citedby/cit_*) is
parsed from author- and publisher-supplied reference lists, so it MISSES large numbers of real
citations, skews toward older and economics-internal work, and barely covers the last ~2 years
(citations lag publication). Working papers and very recent papers therefore look far less cited
than they are. Consequences for how you write scripts:
- Never rank a result set by raw total_citations alone, and never filter out a paper just because
  its citation count is low — especially for post-2022 work or working papers.
- Treat citations as ONE weak signal, combined with journal tier, recency, and semantic relevance.
  Prefer citation_percentile (cohort-relative) over raw counts when you must use citations.
- For "most successful / most impactful" briefs, rank within a comparable cohort (same era + tier),
  and lead with venue/tier as the primary success proxy, citations as a secondary tie-breaker.

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
  All known version links for a paper (working paper → journal, etc.). Matches edges in either
  direction. Returns one row per *linked* paper (never the queried handle itself), with metadata.
  Returns tibble: Handle (the linked paper), type, title, year, authors, journal, category, url,
                  bib_tex, abstract. Metadata columns are NA when the linked handle is outside the
                  articles table. The Handle column drops straight into emit_section/handle_stats/bib_for.
  Example — keep only the *published* sibling(s) of a working paper:
    pub <- versions(wp_handle) |> filter(!is.na(category) & category != "Working Paper Series")

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

### Person finder verbs (economists, not papers)

The database also holds the RePEc Author Service registry (~84k registered economists) joined
to the paper corpus. Use these verbs when the brief asks for PEOPLE: "who works on X",
referee / discussant / speaker / supervisor suggestions, "the main researchers in this area".

person_search(query, max_k = 25, k_papers = 600, scoring_mode = "breadth", quality_weight = 0.3,
              min_year = NULL, journal_filter = NULL, active_since = NULL, min_citations = NULL)
  Two-stage author search: a hidden paper-level semantic search rolled up to registered
  authors, with the matched papers kept as evidence. Returns a tibble, one row per person.
  - query: a mock abstract of the ideal paper BY the person you want (same style as
    semantic_search — 2–4 sentences, not keywords).
  - max_k: persons to return (≤ 25).
  - k_papers: hidden paper pool size (default 600; up to 1000 for broad fields).
  - scoring_mode: "breadth" (default — rewards many matching papers, for "who works in this
    area"), "best_match" (single closest paper, for very specific topics), "blended" (50/50).
  - quality_weight: how much total citations boost the ranking (0 = off, 0.3 default).
  - min_year / journal_filter: restrict the hidden paper search (same semantics as semantic_search).
  - active_since: keep only persons whose most recent work is in or after this year, e.g. 2020L.
    Use for "currently active" / discussant / referee briefs.
  - min_citations: floor on a person's total citations.
  Returns columns: short_id, name_full, workplace_name, homepage, n_matched, overlap_weight,
  best_score, score, evidence_handles/_titles/_journals/_years/_scores (top-5 list columns),
  n_works_in_corpus, total_citations, first_year, last_year, primary_category,
  image_url, wikipedia_url, orcid.

  Example:
    people <- person_search(
      "This paper estimates the labor market effects of minimum wage increases using
       administrative linked employer-employee data and regional variation in the bite
       of the wage floor. We find wage compression with small disemployment effects.",
      max_k = 12, scoring_mode = "breadth", active_since = 2018L
    )
    emit_person_section("Researchers active on minimum wages", people, n = 10)

person_lookup(name, limit = 10)
  Resolve a (partial) name to registered persons, most-cited first.
  Returns tibble: short_id, name_full, workplace_name, homepage, n_works_in_corpus,
  total_citations, first_year, last_year, primary_category.

person_profile(short_id)
  One-row tibble with the full profile: identity + stats (n_works_total, n_works_in_corpus,
  total_citations, a_count, first_year, last_year, primary_category) + Wikidata extras when
  linked (wikipedia_url, image_url, birth_year, birth_place, citizenships, educated_at,
  doctoral_advisors, doctoral_students, memberships, awards, orcid, google_scholar_id, website).
  Array fields are list-columns — pluck with profile$doctoral_advisors[[1]]. Use to enrich the
  top names or answer education/genealogy/awards questions; Wikidata fields are NA for most people.

person_papers(short_id, limit = 100)
  All in-corpus papers of a person, newest first. Returns the standard paper columns
  (Handle, title, year, authors, journal, category, url, bib_tex, abstract) plus work_type —
  the result drops straight into emit_section / handle_stats / bib_for.

person_url(short_id)
  IDEAS author profile URL for a short_id.

The person tables are also queryable via sql_query: persons(short_id, name_full, workplace_name,
workplace_institution, homepage), person_works(short_id, work_handle, work_type) — work_handle is
LOWER-cased, join on LOWER(articles.Handle) —, person_stats(short_id, n_works_total,
n_works_in_corpus, total_citations, a_count, first_year, last_year, primary_category),
person_wikidata(short_id, image_url, wikipedia_url, orcid, doctoral_advisors, awards, ...).
Affiliations (workplace_name) come from the authors' own RePEc registration — never infer them
from elsewhere.

---

### Output verbs

emit_section(title, df, n = 25, note = NULL, mode = NULL)
  Emit a named result section. df must have columns: Handle, title, year, authors, journal,
  category, url (and optionally abstract, similarity). Deduplicates against already-emitted
  handles across the script run — safe to call multiple times with overlapping result sets.
  Each new paper emits a paper event; then a section event groups the handles under title.
  mode labels the section chip in the UI: one of "semantic", "keyword", "journal_scan",
  "author", "wp", "editor", "custom". It defaults sensibly (semantic_search results →
  "semantic", SQL results → "keyword") — set it only when the default reads wrong, e.g.
  mode = "author" for an author-name sweep or "journal_scan" for a single-journal pass.

emit_person_section(title, df, n = 10, note = NULL)
  Emit a section of PERSON results — df must come from person_search() (or carry its columns).
  Each new person renders as a person card (photo, affiliation, stats, matched-paper evidence);
  deduplicates by short_id across the run. Do NOT pass person rows to emit_section() — papers
  and persons render as different cards.

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

You may use: base R, dplyr, tidyr, stringr, purrr, glue.
These packages are pre-attached and available without library().
For dates, use base R (Sys.Date(), format(x, "%Y"), as.Date, difftime) — lubridate is not available.

Useful patterns:
  all_handles <- character(0)                             # accumulate handles
  all_handles <- unique(c(all_handles, result$Handle))    # add section results
  bind_rows(df1, df2) |> distinct(Handle, .keep_all = TRUE)  # merge + dedup
  this_year <- as.integer(format(Sys.Date(), "%Y"))       # for "last N years" filters
  ids <- map(handles, ~ versions(.x)$handle) |> list_c() |> unique()  # chain verbs

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
