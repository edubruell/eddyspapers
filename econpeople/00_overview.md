# econpeople — Person Finder (design overview)

**Status:** design draft — no code yet. This is the first design pass; several
decisions below are marked **[OPEN]** and need a direction call before build.

## What it is

A third product in the eddy's-papers family: a **person finder for economists**
at `econpeople.eduard-bruell.de`. It takes the RePEc Author Service (`pers`)
archive — ~84k registered authors — gets it into the same DuckDB, and exposes a
search surface that mirrors **base eddyspapers**, but where the unit of search is
a *person* instead of a *paper*.

The headline capability: **find authors by topic or natural-language query**
("who works on monetary policy in commodity-exporting economies?"). Crucially we
do **not** average each author into a single vector — that would blend Acemoglu's
automation work with his democracy work into mush. Instead we use
**two-stage overlap retrieval**: run a large *hidden* paper-level semantic search
(the existing base-eddyspapers vector search), then roll the matched papers up to
their authors via `person_works` and rank authors by weighted overlap. An
author's automation papers surface him for "automation" and his democracy papers
for "democracy" — same person, no blending — and the matched papers are shown as
**evidence** for why each author ranked. See `01_data_model.md` §3.5.

## The product family (shared rails, three surfaces)

| Product | URL | Unit | Logo |
|---|---|---|---|
| Classic search | `econpapers.eduard-bruell.de` | paper | meerkat with a paper |
| Agentic search | `agenticsearch.eduard-bruell.de` | lit-review | detective meerkat |
| **Person finder** | `econpeople.eduard-bruell.de` | **person** | **Diogenes meerkat** |

All three read the **same DuckDB** (`articles`, `handle_stats`, `cit_*`,
`journals`, `versions`, `bib_coupling`) and the person finder adds person tables
alongside. No data is duplicated: an author's papers, citations, impact stats and
embeddings are *joined in* from tables we already maintain.

### Branding

The Diogenes meerkat: a meerkat **in a toga**, holding an **old-style oil lamp**,
**climbing out of a barrel (Fass)** — the reference is Diogenes of Sinope
searching for an honest human ("Ich suche Menschen"). Sibling to the existing
meerkat mascots: same character, new pose/props, same palette with an accent
shift (see classic `frontend/` + `agentic/03_interface.md` for the shared design
system the person-finder frontend will reuse).

## Why it's cheap to build (the key insight)

Each `ReDIF-Person` record carries a stable **`Short-Id`** (e.g. `pac16` =
Acemoglu) *and the list of that author's work handles* (`author-paper:`,
`author-article:`, `author-chapter:`). Those handles are exactly the `Handle`
values in our `articles` table. So **person → papers is a direct handle join —
no name disambiguation** for registered authors.

Verified on real data: Acemoglu's profile lists 740 works; **319 are in our
corpus** and joined instantly on `LOWER(handle)`. Everything a researcher cares
about (impact, topics, coauthors, trajectory) is derivable from that join plus
tables we already have.

## How it's most useful to researchers (design north star)

The person finder should answer questions that are painful today:

1. **Expert finding / "who works on X?"** — semantic topic → ranked authors.
   Direct value for: building a lit-review author list, finding seminar
   speakers, suggesting (non-conflicted) referees, scouting collaborators.
2. **Disambiguated identity** — "which J. Smith?" solved by `Short-Id`. A clean
   canonical author page with *their* papers, not a name-collision mess.
3. **Author profile** — papers-in-corpus, citation impact (summed from
   `handle_stats`), topic fingerprint, journals, active years, Top-5 count.
4. **"Authors like this one"** — research similarity by *shared-literature
   overlap* (seed the search with an author's own papers; §`02`/5), distinct from
   coauthorship. Useful for referee suggestion and finding adjacent people.
5. **Institution / cohort views** — group by `Workplace-Institution` (EDI
   handle) for department rosters; "rising" authors by recent topic activity.
6. **Agentic reuse** — the same person tables sit in the shared DuckDB, so the
   agentic sandbox can query them in a script. (Via the DB, not a person-finder
   API or MCP server — no MCP for econpeople.)

The throughline: **base-eddyspapers UX, but for people** — a query box, optional
filters (field, institution, active-since, min-citations), a ranked list of
author cards. Familiar on day one.

## Scope: now vs. later

**Phase A — all base `pers` data (this design's focus).**
Ingest every registered author, link to corpus, compute precomputed
`person_stats`, ship topic-search (two-stage overlap) + profile endpoints and a
dedicated frontend.

**Phase B — enrichment for a high-value subset (long-term).**
For authors who ever published in a Top-5 journal **plus a manual shortlist**,
discover and scrape homepage/CV/ORCID/Scholar, run LLM extraction (fields,
editorial roles, full publication list), and fold the text into the index. This
is the `roadmap.md` v0.5.1–0.5.2 track; it is **out of scope for the first
build** and gets its own doc (`02_enrichment.md`) once Phase A lands.

## Non-goals (first build)

- No coauthor-graph analytics / network viz (later: `roadmap.md` v0.7.1/0.9.0).
- No website scraping or LLM extraction (that's Phase B).
- No attempt to resolve **non-registered** authors from free-text author strings
  unless we decide to (see `01_data_model.md` **[OPEN-1]**).
- No edits to base `frontend/` or `backend/` Plumber routes beyond *adding*
  person endpoints/tables; existing products keep working untouched.

## Decisions (resolved 2026-06-05)

- **[D-1] Coverage — registered `pers` only.** Clean deterministic handle-join,
  no name disambiguation. Non-registered authors deferred (heuristic, later).
- **[D-2] Topic search — two-stage overlap retrieval, not author vectors.**
  Hidden large paper search → roll up to authors via `person_works` → rank by
  weighted overlap. No averaging; multi-field authors surface per query; results
  carry matched-paper evidence. `person_embeddings` is **not** built for v1.
  (`01` §3.5.)
- **[D-3] Stack — shared backend, separate frontend.** Person endpoints extend
  the existing R/Plumber `eddyspapersbackend` (max infra reuse: same DuckDB,
  same deploy/diff). The person UI is its **own** frontend app — similar to the
  classic one but separate. The current `frontend/` should be **renamed** to
  disambiguate now that there are three surfaces (proposed: `frontend_econpapers/`;
  see `01` §7). Rename is a separate, confirmed step — not done as part of design.
- **[D-4] Personal data — professional identity only.** Store & expose name,
  affiliation (`Workplace-Name` + EDI handle), and **homepage** (linked), plus
  derived stats and works. **Email is not exposed** (sensitive / GDPR-awkward);
  phone & postal are dropped. (`01` §2, §6.)

- **[D-5] Ranking — relevance-led with a toggle-able quality blend.** Topical
  overlap is the primary signal; a small prominence term (citations / Top-5 from
  `person_stats`) nudges strong authors up, exposed as a `quality_weight` toggle
  (0 = pure relevance). (`01` §3.5.)

Still genuinely open: **[OPEN-5]** keep secondary affiliations (multi-workplace)
or primary only — low-stakes, default to primary + a thin side table.

## Doc map

| # | File | Owns |
|---|---|---|
| 00 | `00_overview.md` | this file: vision, product family, branding, usefulness, scope, non-goals |
| 01 | `01_data_model.md` | getting `pers` into the DB: parser, tables, linkage, two-stage search, pipeline + diff integration |
| 02 | `02_api.md` | endpoint surface: topic→author search, profile, full publication list, name lookup, ranking params |
| 03 | `03_enrichment.md` | *(later)* Phase B: website discovery + scraping + LLM extraction for the Top-5/shortlist subset |

**Frontend is deferred** — no person-finder UI yet (decided 2026-06-05). The
person finder ships as a plain JSON API first (no MCP); the Diogenes-meerkat
Astro/React app consumes it later and gets its own doc then.
