---
name: lit-search
description: Run a structured literature search over ~480k RePEc economics papers via the eddysearch MCP server. Clarifies intent, runs one hosted search pipeline (or composed surgical searches), and writes a review, a .bib file and a CSV into the project.
argument-hint: "[topic or intent, e.g. 'bureaucratic quality and migrant integration' or 'editor targeting for JOLE submission']"
allowed-tools: ["Read", "Grep", "Glob", "Write", "Bash", "mcp__eddysearch__lit_search", "mcp__eddysearch__fetch_search", "mcp__eddysearch__find_papers", "mcp__eddysearch__keyword_search", "mcp__eddysearch__find_people", "mcp__eddysearch__corpus_context"]
---

# Literature Search & Review

Semantic + keyword search over ~480k RePEc economics papers and ~88k registered authors,
served by the **`eddysearch` MCP server**. No local R, DuckDB or Ollama.

**Input:** `$ARGUMENTS` — initial description of the search intent.

**Prerequisite.** Tools are named `mcp__eddysearch__<tool>` (this file uses the bare names).
If they are missing, the server is not registered — stop and tell the user to run the
command below with their own key, or to request one at
https://econpapers.eduard-bruell.de/mcp

```
claude mcp add --scope user --transport http eddysearch \
  https://agenticsearch.eduard-bruell.de/mcp --header "Authorization: Bearer YOUR_KEY"
```

## Where the files go

Ask once, then remember. On the first run in a project, look for `.eddysearch.json` in the
project root:

- **It exists** — read `literature_dir` from it and use that. Do not ask again.
- **It does not** — ask the user where literature output should be written, offering
  `literature/` as the default, and accept whatever they name. Then create the directory and
  write their answer to `.eddysearch.json`, telling them you have done so:

```json
{ "literature_dir": "literature" }
```

Everything this skill produces goes inside that one directory:

| File | Contents |
|---|---|
| `lit_<slug>.md` | the review you write |
| `results_<slug>.bib` | BibTeX for every paper found |
| `results_<slug>.csv` | the flat results table |
| `found_handles.csv` | running log of every handle ever surfaced, across all searches |

`<slug>` is the `slug` field the run returns: a short filename-safe name derived from the
brief, so repeated searches do not overwrite each other. Nothing is ever written outside the
chosen directory without asking first.

## Corpus coverage — read before promising anything

- **Coverage starts in 1995.** Nothing earlier exists. A 1994 classic (Card & Krueger,
  say) is genuinely absent — that is coverage, not a defect. Never tell the user a
  pre-1995 paper is "missing from the literature".
- ~480k articles; `corpus_context` (free, cached) reports the snapshot date and the valid
  category/journal filter values. Call it before guessing.
- 1995–2000 is thin (~1.8k–4.5k papers/year); 2001 onward is dense, with good journal
  coverage (QJE runs 40–70 papers/year).

### What the categories actually contain

`corpus_context` gives counts and example journals but not this — and the labels mislead:

| Category | Trap |
|---|---|
| **General Interest** | ~75% **Nature** (54k of 72k), mostly non-economics. **RESTAT and JEEA live here, not Top Field (A).** |
| **Top Field Journals (A)** | A ranking of field journals, so it legitimately holds business/finance/stats — Management Science, JASA. Not a data defect. |
| **Working Paper Series** | Inflated by MPRA (40k, self-uploaded and unvetted) and arXiv (32k, all sciences). To hit NBER/IZA/CESifo, pair with `journal_name`. |
| **AEJs** | The *smallest* category (6k), separate from Top 5 (10k) — include it explicitly when the user means "top journals". |

Deviating from the default mix: add **Other Journals** for applied/regional/policy topics;
drop **General Interest** when the Nature bulk is drowning the results; drop **Second in
Field (B)** when the user wants only frontier work.

---

## Phase 0: Orient

Skim the project for context before asking anything — it makes the questions sharper:

- any draft `.tex`/`.md`, existing `.bib` files, project notes
- `found_handles.csv` in the literature directory, if earlier searches have run

Do not read the whole draft. You need the topic, the method stance, and what is already cited.

## Phase 1: Clarify

Ask **2–4 targeted questions**, then stop and wait. Good questions resolve:

- **Purpose** — related-work section? referee hunt? journal targeting? gap-finding?
- **Scope** — mechanism and outcome of interest; what is explicitly out of scope
- **Method stance** — causal/empirical only, or theory and descriptive too?
- **Vintage** — recent frontier (`min_year`), or foundational work back to 1995?
- **Venue** — top-5 / top-field only, or working papers included?

Skip this phase only when the user's brief already answers all of it, or they said "just go".

## Phase 2: Search

**Default: one `lit_search` call.** It writes and runs a tailored multi-section script
(semantic + keyword + journal/author scans) server-side and returns the papers it found.

```
lit_search(
  brief:        <2-6 sentences of abstract-style prose — mechanism, method, context>,
  min_year:     <optional>,
  categories:   [<optional, from corpus_context>],
  must_include: [<authors/handles that must appear if in corpus>],
  refine:       true,   # optional: one results-aware refine pass
  skip_clarify: true    # default true over MCP; false returns structured questions instead
)
```

Write the `brief` as **prose describing the mechanism**, not topic labels.

- Good: *"Causal effects of minimum wage increases on low-wage employment, using
  border-discontinuity and synthetic-control designs in US state panels."*
- Bad: *"minimum wage, employment, labor economics"*

**The server finds the papers. You write the review.** That is the normal mode, not a
degraded one: `lit_search` returns results only, and asking the server to write the review
instead (`synthesize: true`) needs a scope that ordinary keys are not granted. Do not
request it, and do not treat its absence as a failure.

**Long runs come back as `status: "running"`.** A search takes 1-3 minutes, longer with
`refine: true`. If it is not done after about 40 seconds, the result has `status: "running"`
and a `search_id`. Wait `retry_after_sec`, then repeat the identical `lit_search` call: it joins
the running search and returns its results, with no second run and no quota spent. Do not
reword the brief in between; a different brief is refused while yours is still running.

**Large runs come back as a handle.** A big result set does not fit in one tool result, so
the response may carry a digest of every paper plus a `search_id` instead of the full
artifacts. When that happens, pull what you need with `fetch_search`:

```
fetch_search(search_id: <id>, part: "bibtex" | "csv" | "papers" | "script" | "overview")
```

`papers` and `csv` paginate — pass `offset` and `limit` and walk them to the end. The digest
alone is usually enough to write from; fetch `papers` when you need the abstracts.

**Surgical alternative.** When the user wants raw rows rather than a review, compose the
cheap tools directly (no LLM, much faster):

| Need | Tool |
|---|---|
| Semantic neighbourhood of an idea | `find_papers` (abstract-style prose query) |
| Exhaustive sweep for a known term/phrase | `keyword_search` (title default; `match:"all"` to AND) |
| Referees, collaborators, who works on X | `find_people` |
| Filter values, corpus size, snapshot date | `corpus_context` |

Use surgical mode for "everything in JPubE mentioning X", "who could referee this",
"is there anything newer than Y". Use `lit_search` when the deliverable is a review.

**Editor / journal targeting** is a surgical composition, not a `lit_search`: run
`keyword_search` with `journal_name` set to the target journal to see what it actually
publishes on the topic, then `find_people` on the same topic to identify likely editors and
referees. Report fit as evidence (what the journal has published, who handles it), not as a
verdict.

## Phase 3: Write the outputs

The result carries:

| Field | Contents |
|---|---|
| `papers` | handle → full paper object (title, authors, year, journal, abstract, stats) |
| `bibtex` | deduped BibTeX for every paper found |
| `papers_csv` | flat table: handle, title, authors, year, journal, category, url, abstract, max_similarity, sections, cites_internal, cites_total, percentile |
| `sections` | per-section handles + similarity ranks |
| `persons` | present only when the run surfaced authors |
| `strategy`, `script` | what it searched and the script it ran |
| `search_id`, `resource_uri` | re-fetch the whole run later, free |
| `slug` | a filename-safe name for this run, for naming the three files |

Write three files into the literature directory from `.eddysearch.json`:

- `lit_<slug>.md` — the review, which **you** write from the rows
- `results_<slug>.bib` — the returned BibTeX, verbatim
- `results_<slug>.csv` — the returned CSV, verbatim

Shape the review as a short **Overview**, then **Key Papers** with 2–4 sentences each,
then **Implications**. Only describe papers whose abstract you actually read — fetch them
if the run came back as a handle. Flag when a working paper and its published version both
appear, and prefer clean identification when ranking.

Then **append to `found_handles.csv`** in the same directory — create it with header
`handle,search_slug,date_found` if absent. This is the running log across all searches;
`lit-check` cross-references it. Append only handles not already present.

## Phase 4: Report back

Tell the user, briefly:

- how many papers, across which sections, and the `search_id`
- where the three files went
- the 3–5 papers that most directly answer the brief
- **honest gaps** — thin sections, and whether thinness is a real gap or a coverage limit
  (pre-1995, or a venue the corpus underweights). Never dress up a thin result as complete.

Offer the obvious next step: a refine pass (`refine: true`), a surgical sweep of a specific
journal, or `find_people` for referees.

## Notes

- Same brief + params hits a server-side cache — repeat calls are cheap and stable, and a
  cached run does not count against the hourly limit in the same way a fresh one does.
- `lit_search` is rate-limited (a self-serve key gets 20 an hour). The cheap tools are
  generous by comparison, so prefer them for follow-up questions about a run you already have.
- An ambiguous brief with `skip_clarify: false` returns structured questions rather than
  guessing; with the default `true` it proceeds on its best reading.
- Similarity is a **distance** — *lower is closer*. Don't present it as a match percentage.
  A blank `max_similarity` means the paper entered via a keyword/SQL section, not a semantic
  one — blank is "not scored", never "perfect match".
- A past run can be re-read in a later session with `fetch_search`, or via the
  `agenticsearch://searches/<search_id>` resource. Only the key that made a run can read it.
- The corpus is RePEc/EconLit economics. Adjacent fields appear only where they overlap
  economics; absence there says little.
