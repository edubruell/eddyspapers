# econpeople — API surface (design draft)

Endpoints for the person finder. **API only** — the future Diogenes frontend is
the consumer; **no MCP** (decided 2026-06-05). Routes extend the existing
`eddyspapersbackend` Plumber app (`backend/R/api.R`); they read the person tables
from `01_data_model.md` and reuse the base `/search` vector path. No new data
layer.

Convention follows the existing API (see `CLAUDE.md` "API Endpoints"): JSON in/out,
same connection pool, same error shape.

## 1. `POST /person/search` — topic → authors (the headline)

Natural-language or keyword query → ranked authors, via two-stage overlap
retrieval (`01` §3.5). This is the endpoint the whole product is built around.

**Request**
```jsonc
{
  "query": "optimal monetary policy in commodity-exporting economies",
  "k_papers": 1000,        // hidden Stage-1 paper pool (default 1000, max 4000)
  "quality_weight": 0.3,   // [D-5] 0 = pure topical relevance; higher = prominence
  "limit": 25,             // authors returned
  "offset": 0,
  "filters": {             // all optional, applied in Stage 1 and/or Stage 2
    "min_year": 2015,            // restrict Stage-1 papers by article year
    "category": ["Top 5 Journals", "Top Field Journals (A)"],
    "institution": "RePEc:edi:edmitus",   // EDI handle (Stage-2 filter on persons)
    "active_since": 2018,        // person_stats.last_year >= ...
    "min_citations": 100         // person_stats.total_citations >= ...
  }
}
```

**Response**
```jsonc
{
  "query": "...",
  "n_authors": 25,
  "results": [
    {
      "short_id": "pac16",
      "name_full": "Daron Acemoglu",
      "workplace_name": "Massachusetts Institute of Technology (MIT)",
      "workplace_institution": "RePEc:edi:edmitus",
      "homepage": "https://economics.mit.edu/people/faculty/daron-acemoglu",
      "score": 12.84,            // final blended score
      "overlap_weight": 11.2,    // Σ similarity (relevance only)
      "n_matched": 7,            // papers of theirs in the top-K pool
      "stats": {                 // from person_stats, for display + the toggle
        "n_works_in_corpus": 319,
        "total_citations": 184302,
        "top5_count": 41,
        "first_year": 1999, "last_year": 2025
      },
      "evidence": [              // WHY they ranked — matched papers, best first
        { "handle": "RePEc:...", "title": "...", "journal": "...",
          "year": 2017, "score": 0.71 }
      ]
    }
  ]
}
```

Notes:
- `evidence` is the explainability win — show the matched papers, not an opaque
  vector. Cap at e.g. top-5 per author in the response.
- `quality_weight` maps to `λ` in `score = overlap_weight·(1 + λ·quality_norm)`.
- Stage-1 query embedding uses the same mock-abstract/HyDE style as base search
  (`9d4d3e9`), so topical behaviour matches classic eddyspapers.

## 2. `GET /person/{short_id}` — author profile

Everything for a canonical author page, no runtime vector work.
```jsonc
{
  "short_id": "pac16",
  "name_full": "Daron Acemoglu",
  "workplace_name": "...", "workplace_institution": "RePEc:edi:edmitus",
  "homepage": "https://...",         // linked [D-4]
  "registered_date": "1999-...", 
  "stats": { /* full person_stats row */ },
  "category_breakdown": [            // their corpus papers by journal category
    { "category": "Top 5 Journals", "n": 41 }, ...
  ],
  "top_journals": [ { "journal": "American Economic Review", "n": 23 }, ... ]
}
```
No email/phone/postal (per [D-4]).

## 3. `GET /person/{short_id}/papers` — full expandable publication list

The author's **complete registered works** (all of `person_works`, not just the
in-corpus subset), so a profile can show *everything* and expand on demand. Two
tiers in one response:

- **in-corpus** works (`person_works ⋈ articles`) → rich rows: title, journal,
  year, category, abstract (for the expandable card), BibTeX, and citation stats
  from `handle_stats`. These render like classic result cards.
- **out-of-corpus** works (registered handles not in `articles` — other
  journals/series, or outside our year cutoffs) → thin rows: the `repec` handle,
  `work_type`, and a link out to its IDEAS/EconPapers page. No metadata we don't
  have, but the work is still listed so the list is honest and complete.

**Request**
```jsonc
{ "sort": "year",            // year | citations | journal  (in-corpus tier)
  "order": "desc",
  "include_out_of_corpus": true,   // default true; false = only rich rows
  "limit": 50, "offset": 0 }
```
**Response shape**
```jsonc
{
  "short_id": "pac16",
  "counts": { "total": 740, "in_corpus": 319, "out_of_corpus": 421 },
  "in_corpus": [
    { "handle": "RePEc:aea:aecrev:...", "title": "...", "journal": "...",
      "year": 2017, "category": "Top 5 Journals", "abstract": "...",
      "bib_tex": "...", "citations": 1234, "work_type": "article" }
  ],
  "out_of_corpus": [
    { "handle": "repec:nbr:nberwo:14674", "work_type": "paper",
      "ideas_url": "https://ideas.repec.org/p/nbr/nberwo/14674.html" }
  ]
}
```
This is the data behind the **expand-to-see-all-papers** view: a profile shows
the header + headline stats, and expanding pulls the in-corpus cards (with
per-paper abstract expansion, like classic `ResultCard`) plus the complete
out-of-corpus tail. Paginated so prolific authors (Acemoglu: 740 works) stay
responsive — page the in-corpus tier; the out-of-corpus tail can lazy-load.

## 4. `GET /person/lookup?name=...` — name search / autocomplete

Fast prefix/fuzzy lookup over `persons` by name for "I know who I want." Returns
`short_id`, `name_full`, `workplace_name`, `n_works_in_corpus` for disambiguation
(the classic "which J. Smith?" — now resolved by `short_id`). Backs a typeahead
later; usable directly now.

## 5. `GET /person/{short_id}/similar` — authors with similar work *(v1.1)*

"Researchers like this one," by *research* not coauthorship. Reuses the same
overlap mechanism with the author's own papers as the seed query: take their top
in-corpus papers as vectors, retrieve a paper pool, exclude self, roll up to
authors. No author-vector table needed. Mark v1.1 — ships after the core three.

## 6. Out of scope here

- Ranking-formula tuning (`quality_norm`, `λ`, floors/caps) — empirical, iterate
  post-launch against real queries.
- Frontend / Diogenes UI — deferred; separate doc when we build it.
- Enrichment-derived fields (scraped homepage text, extracted fields, full pub
  lists) — Phase B, `03_enrichment.md`.
