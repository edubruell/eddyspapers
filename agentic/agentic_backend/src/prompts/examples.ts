export const examplesPrompt = `\
## Worked example scripts

These examples show the expected structure and style. Study the brief → script mapping.

---

### Brief
Find papers on the employment effects of minimum wages, focusing on high-quality empirical
work from top journals and recent working papers.

\`\`\`r
emit_note("Strategy: keyword sweep over top journals, two semantic sections varying framing, WP scan.")

all_handles <- character(0)

# --- Section 1: keyword sweep over top journals ---
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

# --- Section 2: semantic — employment and hours effects ---
sem1 <- semantic_search(
  "Minimum wage increases and their effects on employment levels, hours worked, and earnings.
   Studies examining whether higher wage floors reduce employment, shift hours to part-time,
   or generate worker welfare gains. Includes monopsony models and competitive labor market tests.",
  max_k = 25, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)", "General Interest"),
  min_year = 2005L
)
emit_section("Semantic: employment and hours effects (published)", sem1, n = 20)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 3: semantic — causal identification designs ---
sem2 <- semantic_search(
  "Causal identification of minimum wage effects using regression discontinuity, bunching
   estimators, synthetic control, or cross-border comparisons. Studies that exploit spatial
   or temporal variation in minimum wage legislation to isolate employment and earnings effects.",
  max_k = 20, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)", "General Interest"),
  min_year = 2010L
)
emit_section("Semantic: RD and quasi-experimental designs", sem2, n = 15)
all_handles <- unique(c(all_handles, sem2$Handle))

# --- Section 4: recent working papers ---
wps <- semantic_search(
  "Recent empirical research on minimum wage effects on employment, hours, turnover, and
   earnings inequality. New quasi-experimental evidence from administrative records or
   linked employer-employee data.",
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
emit_note("Strategy: SQL author chains for key researchers, semantic section on mechanisms, citation network for co-author discovery.")

all_handles <- character(0)

# --- Section 1: papers by known researchers ---
# Use SQL LIKE chains for specific surnames; broaden as needed
authors_sql <- sql_query(
  "SELECT Handle, title, year, authors, journal, category, url, bib_tex, abstract
   FROM articles
   WHERE (LOWER(authors) LIKE '%borjas%'
          OR LOWER(authors) LIKE '%card%'
          OR LOWER(authors) LIKE '%peri%'
          OR LOWER(authors) LIKE '%dustmann%'
          OR LOWER(authors) LIKE '%glitz%')
     AND (LOWER(title) LIKE '%immigr%' OR LOWER(title) LIKE '%wage%' OR LOWER(title) LIKE '%labor supply%')
     AND year >= 2000
   ORDER BY year DESC LIMIT 80"
)
emit_section("Papers by key immigration-wage researchers", authors_sql, n = 25)
all_handles <- unique(c(all_handles, authors_sql$Handle))

# --- Section 2: semantic — wage and labor market effects of immigration ---
sem1 <- semantic_search(
  "How does immigration affect wages and labor market outcomes for native workers?
   Evidence on wage complementarity, substitution effects between immigrant and native skill groups,
   regional labor market adjustments, and distributional consequences of immigration shocks.",
  max_k = 25, journal_filter = c("Top 5 Journals", "AEJs", "Top Field Journals (A)"), min_year = 2005L
)
emit_section("Semantic: immigration and wages (top journals)", sem1, n = 20)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 3: co-citation network — find connected papers ---
# Find papers that cite a central paper to discover related work
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
  "Recent empirical studies on immigration and native wages using administrative linked data,
   shift-share IV, or policy discontinuities. German, Austrian, or European evidence preferred.",
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
emit_note("Strategy: JOLE-focused semantic search + keyword chains to cover full journal scope.")

all_handles <- character(0)

# --- Section 1: JOLE semantic — job search theory ---
sem1 <- semantic_search(
  "Theoretical models of job search, matching frictions, and labor market equilibrium.
   Wage posting, directed search, frictional unemployment, worker-firm matching, and
   on-the-job search. Contributions to the Mortensen-Pissarides framework and extensions.",
  max_k = 30, journal_name = "Journal of Labor Economics"
)
emit_section("JOLE: job search theory and matching models", sem1, n = 25)
all_handles <- unique(c(all_handles, sem1$Handle))

# --- Section 2: JOLE semantic — empirical job matching ---
sem2 <- semantic_search(
  "Empirical evidence on job search behavior, unemployment duration, match quality, and
   worker mobility. Studies using linked employer-employee data, survey data on job offers
   and acceptances, or administrative unemployment spell records.",
  max_k = 25, journal_name = "Journal of Labor Economics"
)
emit_section("JOLE: empirical job search and mobility", sem2, n = 20)
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
`;
