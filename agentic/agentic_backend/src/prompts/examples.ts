export const examplesPrompt = `\
## Worked example scripts

These examples show the expected structure and style. Note that every semantic_search query
is a **mock abstract** — 2–4 sentences written as if they were the abstract of an ideal result.

---

### Brief
Find papers on the employment effects of minimum wages, focusing on high-quality empirical
work from top journals and recent working papers.

\`\`\`r
all_handles <- character(0)

# --- Section 1: keyword sweep over top and field journals ---
kw <- sql_query(
  "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
   FROM articles
   WHERE category IN ('Top 5 Journals', 'AEJs', 'Top Field Journals (A)')
     AND (LOWER(title) LIKE '%minimum wage%' OR LOWER(title) LIKE '%wage floor%'
          OR LOWER(title) LIKE '%minimum-wage%')
   ORDER BY year DESC LIMIT 80"
)
emit_section("Top-journal keyword hits (minimum wage)", kw, n = 25)
all_handles <- unique(c(all_handles, kw$Handle))

# --- Section 2: semantic — employment and hours effects (mechanism framing) ---
sem1 <- semantic_search(
  "This paper examines the employment and hours effects of minimum wage increases in
   low-wage labor markets. We find that higher wage floors reduce employment margins
   through delayed hiring and shifts to part-time work, with monopsonistic sectors
   showing smaller disemployment than competitive models predict.",
  max_k = 25, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)",
                                   "General Interest"),
  min_year = 2005L
)
emit_section("Semantic: employment and hours effects (published)", sem1, n = 20)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 3: semantic — causal identification (methods framing) ---
sem2 <- semantic_search(
  "Using a bunching estimator and regression discontinuity around the statutory minimum
   wage, this paper identifies causal employment effects. Cross-border comparisons of
   contiguous counties exploit spatial variation in wage bite, and synthetic control
   methods recover counterfactual employment trends.",
  max_k = 20, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)",
                                   "General Interest"),
  min_year = 2010L
)
emit_section("Semantic: quasi-experimental identification designs", sem2, n = 15)
all_handles <- unique(c(all_handles, sem2$Handle))

# --- Section 4: recent working papers ---
wps <- semantic_search(
  "This working paper estimates the effect of minimum wage increases on employment
   and earnings inequality using administrative linked employer-employee data.
   We exploit staggered policy variation across states or regions and find evidence
   of significant wage compression with small negative employment effects.",
  max_k = 15, journal_filter = c("Working Paper Series"), min_year = 2019L
)
emit_section("Recent working papers (2019+)", wps, n = 12)
all_handles <- unique(c(all_handles, wps$Handle))

emit_bibtex(all_handles)
\`\`\`

---

### Brief
I want to find recent papers by the main researchers working on immigration and wages,
and identify which journals and editors are most active in this area.

\`\`\`r
all_handles <- character(0)

# --- Section 1: papers by known researchers ---
authors_sql <- sql_query(
  "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
   FROM articles
   WHERE (LOWER(authors) LIKE '%borjas%'
          OR LOWER(authors) LIKE '%card%'
          OR LOWER(authors) LIKE '%peri%'
          OR LOWER(authors) LIKE '%dustmann%'
          OR LOWER(authors) LIKE '%glitz%')
     AND (LOWER(title) LIKE '%immigr%' OR LOWER(title) LIKE '%wage%'
          OR LOWER(title) LIKE '%labor supply%')
     AND year >= 2000
   ORDER BY year DESC LIMIT 80"
)
emit_section("Papers by key immigration-wage researchers", authors_sql, n = 25)
all_handles <- unique(c(all_handles, authors_sql$Handle))

# --- Section 2: semantic — wage effects of immigration (mechanism framing) ---
sem1 <- semantic_search(
  "This paper examines how immigration affects wages of native workers, distinguishing
   between complementarity and substitution across skill groups. Using a shift-share
   instrument for immigration flows, we find that high-skilled immigration raises native
   wages while low-skilled inflows compress wages at the bottom of the distribution.",
  max_k = 25, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)"),
  min_year = 2005L
)
emit_section("Semantic: immigration and native wages (top journals)", sem1, n = 20)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 3: co-citation network — find connected papers ---
if (nrow(authors_sql) > 0) {
  central_handle <- authors_sql$Handle[[1]]
  co_cited <- citedby(central_handle, limit = 30)
  if (nrow(co_cited) > 0) {
    emit_section(paste0("Papers citing: ", authors_sql$title[[1]]), co_cited, n = 20)
    all_handles <- unique(c(all_handles, co_cited$Handle))
  }
}

# --- Section 4: recent working papers ---
wps <- semantic_search(
  "This working paper estimates wage effects of recent immigration waves using
   administrative linked data and a shift-share instrument. We find regional
   labour market adjustments with heterogeneous effects across native skill groups,
   with evidence of downward wage pressure on low-wage workers in receiving areas.",
  max_k = 15, journal_filter = c("Working Paper Series"), min_year = 2020L
)
emit_section("Recent WPs on immigration and wages (2020+)", wps, n = 12)
all_handles <- unique(c(all_handles, wps$Handle))

emit_bibtex(all_handles)
\`\`\`

---

### Brief
Do an exhaustive search of the Journal of Labor Economics for papers on job search and
matching models, both theoretical and empirical.

\`\`\`r
all_handles <- character(0)

# --- Section 1: JOLE semantic — job search theory (theory framing) ---
sem1 <- semantic_search(
  "This paper develops a model of directed job search with heterogeneous workers and firms.
   In equilibrium, wage posting leads to a non-degenerate wage distribution, and
   on-the-job search generates worker-firm sorting. The model matches observed patterns
   of wage dispersion, unemployment duration, and job-to-job mobility.",
  max_k = 30, journal_name = "Journal of Labor Economics"
)
emit_section("JOLE: job search theory and matching models", sem1, n = 25)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 2: JOLE semantic — empirical job search (empirics framing) ---
sem2 <- semantic_search(
  "Using linked employer-employee data and unemployment spell records, this paper
   estimates the determinants of re-employment wages and match quality after job loss.
   Search frictions generate substantial wage dispersion conditional on worker
   characteristics, and workers accept lower wages to exit unemployment faster.",
  max_k = 25, journal_name = "Journal of Labor Economics"
)
emit_section("JOLE: empirical job search and worker mobility", sem2, n = 20)
all_handles <- unique(c(all_handles, sem2$Handle))

# --- Section 3: keyword sweep over JOLE ---
jole_kw <- sql_query(
  "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
   FROM articles
   WHERE LOWER(journal) LIKE '%journal of labor economics%'
     AND (LOWER(title) LIKE '%job search%' OR LOWER(title) LIKE '%matching%'
          OR LOWER(title) LIKE '%unemployment duration%' OR LOWER(title) LIKE '%frictional%'
          OR LOWER(title) LIKE '%wage posting%' OR LOWER(title) LIKE '%directed search%')
   ORDER BY year DESC LIMIT 80"
)
emit_section("JOLE keyword: search, matching, frictions", jole_kw, n = 20)
all_handles <- unique(c(all_handles, jole_kw$Handle))

emit_bibtex(all_handles)
\`\`\`

---

### Brief
What were the most successfully published ZEW working papers in the last five years?

This is a **multi-step / chained** brief: one query feeds the next inside a single script. Find the
ZEW discussion papers that *reached a journal*, then rank those journal versions. Do it in one script.

**Critical pitfall: do NOT take the newest WPs.** "Published in the last five years" sounds like
"newest", but WP-to-journal lag is 2-4 years, so the *newest* ZEW DPs are exactly the ones not yet
published. Selecting the newest with ORDER BY year DESC LIMIT returns brand-new WPs with zero
published siblings and an empty result. Restrict to WPs *issued* in the window and let the
version_links join keep only those that actually reached a journal (no recency sort on the WP side).
The efficient resolver is a single version_links join in SQL, not a per-handle versions() loop:
version_links(source, target, type) holds directed WP-to-journal edges; join articles on the other end.

\`\`\`r
all_handles <- character(0)
this_year <- as.integer(format(Sys.Date(), "%Y"))

# --- Step 1+2: ZEW DPs issued in the window that reached a journal, with the journal row ---
# One version_links join: keep only WPs whose linked sibling is a non-WP (published) article.
# No ORDER BY year on the WP side — the published subset skews to the OLDER end of the window.
published <- sql_query(sprintf(
  "SELECT DISTINCT pub.Handle, pub.title, pub.year, pub.authors, pub.journal,
                   pub.category, pub.url, pub.bib_tex, pub.abstract
   FROM articles wp
   JOIN version_links vl
     ON LOWER(wp.Handle) = LOWER(vl.source) OR LOWER(wp.Handle) = LOWER(vl.target)
   JOIN articles pub
     ON LOWER(pub.Handle) = LOWER(CASE WHEN LOWER(vl.source) = LOWER(wp.Handle)
                                       THEN vl.target ELSE vl.source END)
   WHERE wp.category = 'Working Paper Series'
     AND wp.Handle LIKE 'RePEc:zbw:zewdip%%'
     AND wp.year >= %d
     AND pub.category <> 'Working Paper Series'
   LIMIT 500",
  this_year - 5L
))

# --- Step 3: rank by journal prestige first, citations only as a tie-breaker ---
# RePEc citation counts are noisy and under-count recent work, so prestige tier leads the ranking.
if (nrow(published) > 0) {
  stats  <- handle_stats(published$Handle)
  ranked <- published |>
    left_join(stats, by = c("Handle" = "handle")) |>
    mutate(tier_rank = case_when(
      category == "Top 5 Journals"        ~ 1L,
      category == "AEJs"                  ~ 2L,
      category == "Top Field Journals (A)"~ 3L,
      category == "General Interest"      ~ 4L,
      TRUE                                ~ 5L
    )) |>
    arrange(tier_rank, desc(coalesce(total_citations, 0))) |>
    slice_head(n = 20)
  emit_section("Most successfully published recent ZEW discussion papers", ranked, n = 20)
  all_handles <- unique(c(all_handles, ranked$Handle))
} else {
  emit_note("No published journal versions of recent ZEW discussion papers were found in the database.")
}

emit_bibtex(all_handles)
\`\`\`
`;
