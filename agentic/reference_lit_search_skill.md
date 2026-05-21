# Reference — `lit-search` skill snapshot

> **This file is a verbatim snapshot of `~/.claude/skills/lit-search/SKILL.md`**, the Claude Code skill that the agentic search project is modelled on. Kept in the agentic design corpus as a reference document so the build can reproduce the skill's phase plan, mandatory boilerplate, semantic-query guide, journal-category table, and synthesis schema — all referenced by `04_prompts.md`.
>
> **Canonical version lives at `~/.claude/skills/lit-search/SKILL.md`**, not here. Reconcile any drift against that file when this snapshot is refreshed. Snapshot taken: 2026-05-21.
>
> The original skill frontmatter is preserved below for fidelity, even though this file is a reference doc, not a runnable skill.

---

```yaml
name: lit-search
description: Design and run a structured literature search using the local eddyspapersbackend database. Asks clarifying questions, writes a tailored R search script, then synthesizes results into a literature review with a companion .bib file.
argument-hint: "[topic or intent description, e.g. 'bureaucratic quality and migrant integration' or 'editor targeting for JOLE submission']"
allowed-tools: ["Read", "Grep", "Glob", "Write", "Bash", "Task"]
```

# Literature Search & Synthesis

You have access to a local offline semantic search over ~460k economics papers (RePEC subset)
via the `eddyspapersbackend` R package. This skill runs in three phases:

1. **Orient & ask** — read project context, then ask targeted clarifying questions
2. **Write** — generate a tailored R search script
3. **Synthesize** — read results, write a literature review + `.bib` file

**Input:** `$ARGUMENTS` — initial description of the search intent.

---

## Phase 0: Orient

Before asking anything, read the project context:

- Check `local_context/notes/` — read project overview, research question notes, anything
  that helps you understand what the paper/proposal is doing and why.
- Check `local_context/search_related/` — see what searches already exist to avoid duplication.
- Check for a `local_context/article_search_description.md` if present.

If no `local_context/` exists, note that and proceed.

---

## Phase 1: Ask clarifying questions

Based on what you learned in Phase 0 and from `$ARGUMENTS`, ask the user a focused set of
natural language questions **before writing anything**. Tailor the questions to the specific
situation — do not ask generic questions, and do not ask about things you can already infer.

Questions should probe things like:

- **Modes needed.** A literature search can serve different purposes simultaneously.
  Based on what you know, ask which of the following are wanted (framed naturally):
  - *Topic search*: find papers relevant to a specific strand of the literature
  - *Journal-specific scan*: exhaustive keyword + semantic search within one journal
    (useful for placement strategy or when you want to know everything in JOLE/AER/etc.)
  - *Active authors*: identify who is currently publishing in this space
    (useful for knowing whose work to engage with, potential referees)
  - *Recent working papers*: what's in the pipeline from IZA/NBER/ZEW/CESifo etc.
    (useful for scoop risk and finding pre-publication work)
  - *Editor/journal targeting*: look up papers by editorial board members of target
    journals, extract coauthor networks, produce journal fit recommendation

- **Scope.** Year range? Broad (all top journals) or narrow (specific journal)? Include
  working papers alongside published papers? Any journal categories to exclude?

- **Topic nuances.** Are there specific authors whose work should definitely appear?
  Specific country/data context the semantic queries should emphasize? Any related topics
  you should deliberately *not* include because they're out of scope?

- **Purpose.** Is this for a grant proposal, a paper's related literature section, a
  submission cover letter, or something else? This shapes how the synthesis should be written.

Keep questions to the minimum needed. If the intent is clear from context, skip the
corresponding question. Ask in one message and wait for the answer before proceeding.

---

## Phase 2: Write the R search script

**Output paths** (always relative to project root):
- Script: `local_context/search_related/search_[slug].R`
- Raw results: `local_context/search_related/results_[slug].md`
- BibTeX: `local_context/search_related/results_[slug].bib`

where `[slug]` is a short snake_case name for the search.

### Mandatory boilerplate

Every script starts with:

```r
################################################################################
# search_[slug].R — [one-line description]
# Output: local_context/search_related/results_[slug].md
#         local_context/search_related/results_[slug].bib
################################################################################

library(eddyspapersbackend)
library(dplyr)
library(stringr)

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
con    <- get_db_con(read_only = TRUE)
setup_api_pool(max_connections = 5)

DATE     <- format(Sys.Date(), "%Y-%m-%d")
OUT_MD   <- "local_context/search_related/results_[slug].md"
OUT_BIB  <- "local_context/search_related/results_[slug].bib"

# Accumulate all handles across sections for BibTeX export
all_handles <- character(0)

fmt_results <- function(df, n = 25) {
  df <- head(df, n)
  if (nrow(df) == 0) return("*No results.*\n\n")
  lines <- character(nrow(df))
  for (i in seq_len(nrow(df))) {
    sim_str <- if ("similarity" %in% names(df) && !is.na(df$similarity[i]))
      paste0(" | Sim: ", round(df$similarity[i], 4)) else ""
    abs_str <- if ("abstract" %in% names(df) && !is.na(df$abstract[i]) && nchar(df$abstract[i]) > 10)
      paste0("- Abstract: ", df$abstract[i], "  \n") else ""
    lines[i] <- paste0(
      "**", i, ". ", str_trunc(df$title[i], 120), "** (", df$year[i], ")  \n",
      "- Authors: ", str_trunc(df$authors[i], 150), "  \n",
      "- *", str_trunc(df$journal[i], 80), "* | ", df$category[i], sim_str, "  \n",
      abs_str,
      "- Handle: `", df$Handle[i], "`  \n"
    )
  }
  paste(lines, collapse = "\n---\n\n")
}

cat(paste0("# Search Results: [Title]\n\n",
           "*Generated: ", DATE, " | DB: eddyspapersbackend*\n\n---\n\n"),
    file = OUT_MD)
```

### Search sections

Add sections appropriate to the modes requested. Each section appends results to `OUT_MD`
and accumulates handles into `all_handles`. The patterns below are templates — adapt
queries, filters, and section counts to the specific topic and modes requested.

**Keyword SQL section (use for precise term retrieval):**

```r
cat("## KW-1. [Strand name]\n\n", file = OUT_MD, append = TRUE)
kw1 <- DBI::dbGetQuery(con,
  "SELECT Handle, title, year, authors, journal, category, abstract, bib_tex
   FROM articles
   WHERE year >= 2005
     AND category IN ('Top 5 Journals','Top Field Journals (A)','AEJs')
     AND (
       LOWER(title) LIKE '%keyword1%'
       OR LOWER(title) LIKE '%keyword2%'
     )
   ORDER BY year DESC")
all_handles <- c(all_handles, kw1$Handle)
cat(paste0("> N = ", nrow(kw1), "\n\n"), file = OUT_MD, append = TRUE)
cat(fmt_results(kw1, 30), "\n\n", file = OUT_MD, append = TRUE)
```

**Semantic section (use prose abstract as query, not keywords):**

```r
cat("---\n\n## SEM-1. [Strand name]\n\n", file = OUT_MD, append = TRUE)
sem1 <- semantic_search(
  query = "[3–5 sentences of dense abstract-style prose describing the papers you want]",
  max_k = 15,
  journal_filter = "Top 5 Journals, Top Field Journals (A)",
  min_year = 2005
) |> as_tibble()
all_handles <- c(all_handles, sem1$Handle)
cat(paste0("> N = ", nrow(sem1), " | semantic\n\n"), file = OUT_MD, append = TRUE)
cat(fmt_results(sem1, 15), "\n\n", file = OUT_MD, append = TRUE)
```

**Recent working papers section:**

```r
cat("---\n\n## WP. Recent Working Papers (2023+)\n\n", file = OUT_MD, append = TRUE)
wp <- semantic_search(
  query = "[broad version of main query]",
  max_k = 15,
  journal_filter = "Working Paper Series",
  min_year = 2023
) |> as_tibble()
all_handles <- c(all_handles, wp$Handle)
cat(fmt_results(wp, 8), "\n\n", file = OUT_MD, append = TRUE)
```

**Journal-specific scan (for Mode B — exhaustive single-journal coverage):**

```r
# Use journal_name parameter for exact journal matching
sem_jole <- semantic_search(
  query = "[query]",
  max_k = 30,
  journal_name = "Journal of Labor Economics"
) |> as_tibble()

# Plus brute-force SQL on journal name
kw_jole <- DBI::dbGetQuery(con,
  "SELECT Handle, title, year, authors, journal, category, abstract, bib_tex
   FROM articles
   WHERE LOWER(journal) LIKE '%journal of labor economics%'
     AND LOWER(title) LIKE '%keyword%'
   ORDER BY year DESC")
```

**Author lookup (for Mode C — active authors, or specific known authors):**

```r
auth <- DBI::dbGetQuery(con,
  "SELECT Handle, title, year, authors, journal, category, bib_tex
   FROM articles
   WHERE LOWER(authors) LIKE '%lastname%'
     AND year >= 2018
     AND category IN ('Top 5 Journals','Top Field Journals (A)','AEJs')
   ORDER BY year DESC LIMIT 20")
```

**Editor targeting (for Mode E):** Follow the pattern in `05_editors.R` from the
EastGermanWageStructurePaper — build an `editors` list with search patterns, role, and
a relevance note; query each; extract coauthor networks; write `editor_papers.md`,
`editor_coauthors.md`, `journal_recommendation.md`.

### Mandatory BibTeX export (end of every script)

```r
# ── BibTeX + handles export ────────────────────────────────────────────────────
all_handles <- unique(all_handles[!is.na(all_handles) & nzchar(all_handles)])

if (length(all_handles) > 0) {
  placeholders <- paste(paste0("'", gsub("'", "''", all_handles), "'"), collapse = ", ")
  bib_df <- DBI::dbGetQuery(con, paste0(
    "SELECT Handle, bib_tex FROM articles WHERE Handle IN (", placeholders, ")"
  ))
  bib_df <- bib_df[!is.na(bib_df$bib_tex) & nzchar(trimws(bib_df$bib_tex)), ]
  writeLines(paste(bib_df$bib_tex, collapse = "\n\n"), OUT_BIB)
  cat("BibTeX written to:", OUT_BIB, "(", nrow(bib_df), "entries)\n")
} else {
  cat("No handles collected — BibTeX file not written.\n")
}

# ── Master handles log (append to running file across all searches) ────────────
# Path: always local_context/search_related/found_handles.csv
# Columns: handle, search_slug, date_found
# Used for: deduplication across searches, cross-reference in lit-check
MASTER_CSV <- "local_context/search_related/found_handles.csv"

new_rows <- data.frame(
  handle      = all_handles,
  search_slug = "[slug]",        # fill in the slug for this script
  date_found  = DATE,
  stringsAsFactors = FALSE
)

if (file.exists(MASTER_CSV)) {
  existing <- read.csv(MASTER_CSV, stringsAsFactors = FALSE)
  # Only append handles not already in the master log
  new_rows  <- new_rows[!new_rows$handle %in% existing$handle, ]
  combined  <- rbind(existing, new_rows)
} else {
  combined <- new_rows
}

write.csv(combined, MASTER_CSV, row.names = FALSE)
cat("Master handles log updated:", MASTER_CSV,
    "(total:", nrow(combined), "| new this run:", nrow(new_rows), ")\n")

cat("Done. MD written to:", OUT_MD, "\n")
```

---

## Semantic query writing

The embedding model works on dense semantic content. Write each `query` as 3–6 sentences
of abstract-style prose:

- Describe the **mechanism or phenomenon** studied, not just the topic label
- Include **method words** if relevant (quasi-experimental, RCT, IV, matched panel)
- Include **context** if relevant (Germany, refugees, IAB data, transition economy)
- Each SEM section should vary the framing to explore a different facet

Bad: `"bureaucratic quality immigration"`
Good: `"How the quality of local public administration shapes immigrant outcomes. Causal
effects of processing speed, staff discretion, and service quality at immigration offices
on migrants' labour market integration and settlement decisions. Quasi-experimental
variation in administrative capacity across regions of Germany."`

---

## Journal categories — what is actually in each

Categories follow the **ZEW journal ranking**, which covers economics, business, and finance
as one field. This means "Top Field Journals (A)" includes top business and finance journals
alongside top economics journals — all are legitimate. Nature and PNAS appear in "General
Interest" because economists publish there (health, climate, behavioral work) and those
papers are indexed on RePEC.

| Category string | N | Key journals |
|---|---|---|
| `"Top 5 Journals"` | 9,889 | AER, QJE, JPE, REStud, Econometrica; also AER:Insights, JPE:Micro, JPE:Macro |
| `"AEJs"` | 5,919 | JEP, JEL, AEA Papers & Proceedings, AEJ:Applied, AEJ:Policy, AEJ:Micro, AEJ:Macro; also Economic Journal (~800 entries) |
| `"Top Field Journals (A)"` | 43,494 | **Economics:** JOLE (1,025), JHR (1,208), JUE (931), JPubE (2,352), JHE (1,585), JIE (1,587), JET (2,138), JMonE (1,373), RED (1,242), JBES (994), JEH (1,341) — **Business/Mgmt:** Management Science (5,919), Research Policy (2,627), Marketing Science (1,496), Entrepreneurship Theory & Practice (1,323) — **Finance:** JCF (2,158), JFQA (1,733) — **Stats:** JASA (2,157), JRSS-B (960) |
| `"General Interest"` | 70,383 | Nature (52,796), Nature Human Behaviour (1,764), PNAS (564); RESTAT (2,285), JEEA (1,100), The Economic Journal (732); JFE (2,300), RFS (2,466), JF (1,855), Review of Finance (974); APSR (2,430), Annual Review of Economics (413), Brookings Papers (131) |
| `"Second in Field Journals (B)"` | 84,338 | **Labour/applied econ:** Labour Economics (1,677), JEBO (4,939), EER (2,386), JDE (1,965), JEconometrics (2,702), JApplEcono (1,357), JPopE (1,042), World Development (4,522), RAND (460), QE (424), JEGeo (638), IER (813), Exp. Economics (696) — **Energy/environment:** Energy Policy (11,198), Energy Economics (6,632), JEEM (1,361) — **Other:** Economic Modelling (5,387), Journal of Business Ethics (4,784), Small Business Economics (2,069) |
| `"Other Journals"` | 88,427 | Economics Letters (7,630), Health Economics (3,153), Regional Studies (3,130), Empirical Economics (2,675), RSUE (1,234), Oxford Economic Papers (1,329), Scandinavian JE (970), JRS (806), Canadian JE (1,439) |
| `"Working Paper Series"` | 152,854 | **Vetted series:** NBER (19,019), IZA (13,667), CESifo (9,453), CEPR (8,335), World Bank (6,089), ECB (2,002), ZEW (1,435), GLO (1,734), DIW (1,181), SOEPpapers (963), TSE (1,441), Barcelona GSE (1,358), CEP (1,160), Cowles (1,010), Kiel (728), Ruhr (1,021), Cambridge (1,197) — **Open-submission:** MPRA (38,845), arXiv (29,215) |

### Notes on "Working Paper Series"

MPRA (38k) is self-uploaded and unvetted. arXiv (29k) spans all scientific fields. Both
inflate the category count substantially. For targeted searches over institutional series,
combine with `min_year` and either the `journal_name` parameter or a SQL
`LOWER(journal) LIKE '%iza%'` filter.

### Notes on "General Interest"

RESTAT and JEEA are in this category, not in "Top Field Journals (A)". Nature papers
indexed on RePEC are predominantly economics-relevant (health, development, behavioral,
climate). Whether to include this category depends on your topic.

### Default filter

The search engine UI defaults to:
`"Top 5 Journals, General Interest, AEJs, Top Field Journals (A), Second in Field Journals (B)"`

**This default works well for most searches** — top 30 semantic results with these settings
reliably surface the relevant papers. Use it unless there is a specific reason to deviate.

| Deviation | When |
|---|---|
| Add `"Other Journals"` | Comprehensive coverage needed; Economics Letters, Health Economics, etc. |
| Add `"Working Paper Series"` | Recent unpublished work; combine with `min_year` and `journal_name` to avoid MPRA/arXiv |
| Drop `"Second in Field Journals (B)"` | Narrow high-quality search; reduces energy/environment journals |
| Drop `"General Interest"` | When Nature/finance journals are irrelevant to the topic |

Combine as comma-separated string: `"Top 5 Journals, General Interest, AEJs, Top Field Journals (A), Second in Field Journals (B)"`

---

## Phase 3: Ask user to run

After writing the script, tell the user:

> "Script written to `local_context/search_related/search_[slug].R`.
> Before running: make sure Ollama is running (needed for semantic search) and that
> no other R session has the DuckDB open. Let me know when it finishes and I'll synthesize."

Wait for confirmation.

---

## Phase 4: Synthesize

Read `local_context/search_related/results_[slug].md`.
Re-read project context to ensure the synthesis is grounded in the actual research question.

Write synthesis to `local_context/notes/literature/lit_[slug].md`.

### Synthesis format

```markdown
# Literature Synthesis: [Strand Title]

*Strand: [one-line description of what this covers and why it matters for the project]*

---

## Overview

[2–3 paragraphs. What is established, what is contested, and — specifically — what gap
the current project fills. Connect the gap to the identification strategy or contribution.
Every sentence should serve the project; no generic survey prose.]

---

## Key Papers

[10–15 papers. For each:]

**N. Author(s) (Year). "Title." *Journal*.**
[2–4 sentences: what the paper does + main finding + specific relevance to this project.
Be direct. Do not summarize for its own sake.]

---

## Implications for the Project

[1–2 paragraphs connecting this body of work to the current paper's design, gap,
and prior plausibility. Draft-ready for inclusion in a related literature section.]
```

### Selection principles

- Prefer causal identification over descriptive
- Prefer Top 5 / Top Field (A) unless a WP is clearly central
- Prioritize 2020+ for recency; include foundational older papers where necessary
- Only cite papers whose abstracts you actually read in the raw results
- Do not fabricate details — if an abstract is truncated, note it
- Flag when a WP and published version of the same paper both appear

---

## Notes on the DB

- **~460k papers**, mainly economics, from RePEC. Local dump updated periodically.
- **`similarity`** = cosine distance; lower = more similar (0 = perfect)
- **Ollama must be running** for semantic search (`mxbai-embed-large` model)
- **DuckDB is single-writer** — close any other R session before connecting
- **Data root:** `/Users/ebr/eddyspapers/`
- `get_db_con(read_only = TRUE)` is safe when you only need SQL (no semantic search)
