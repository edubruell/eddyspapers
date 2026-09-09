---
name: lit-check
description: Verify a bibliography against the ~480k-paper RePEc corpus via the eddysearch MCP server. Flags citations that cannot be matched, metadata mismatches (year, journal, authors) and citation impact, and cross-references past lit-search runs.
argument-hint: "[path to .bib file, or 'all' to check every .bib in the project]"
allowed-tools: ["Read", "Grep", "Glob", "Write", "Bash", "mcp__eddysearch__verify_references", "mcp__eddysearch__keyword_search", "mcp__eddysearch__corpus_context"]
---

# Bibliography Verification

Checks a bibliography against ~480k RePEc economics papers via the **`eddysearch` MCP
server** to catch:

1. **Unverifiable citations** — entries with no match in the corpus
2. **Metadata mismatches** — wrong year, journal or authors on a real paper
3. **Low-impact citations** — where a more prominent paper may be the expected reference

**Input:** `$ARGUMENTS` — a `.bib` path, or `all`.

**Prerequisite.** Tools are named `mcp__eddysearch__<tool>` (this file uses the bare names).
If they are missing, the server is not registered — stop and tell the user to run the command
below with their own key, or to request one at https://econpapers.eduard-bruell.de/mcp

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

The report this skill writes goes inside that directory, as `bib_check_<date>.md`, alongside
the `found_handles.csv` that `lit-search` maintains. Nothing is written outside it without
asking first.

## What "not found" does and does not mean

This is the single most important thing to get right, and the old version of this skill got
it wrong by implying absence = fabrication.

**Coverage starts in 1995** — the corpus floor, verified. Anything older is absent by
construction: Card & Krueger (1994) is not there, and never will be. 1995–2000 is also
thinner than later years (~1.8k–4.5k papers/year, against tens of thousands later).

From 2001 on, journal coverage is good — QJE, for instance, runs 40–70 papers/year — so a
`not_found` on a recent top-journal article is a genuine signal worth investigating rather
than shrugging off.

Still, `not_found` means **"not verifiable against this corpus"**, not "fabricated".
Legitimate reasons for a miss:

- published before 1995, or in the thin 1995–2000 window
- a book, chapter, thesis, report or policy brief — the corpus is articles and working papers
- outside economics (pure stats, CS, medicine) except where it overlaps economics
- indexed under a different title (working-paper title ≠ published title is very common)
- **a malformed payload** — see the two traps in Phase 1, which are far more likely than a
  fabricated citation

Report misses as **"could not verify — check manually"** and say which reason is likely.
Only escalate to "this may not exist" when the entry is post-1995, in-scope, in an economics
journal, and a follow-up `keyword_search` on distinctive title words also comes back empty.

---

## Phase 0: Extract the entries

Read the `.bib` (or `.tex`/`.md`) and parse entries yourself — this stays your job.

Finding the entries: in `.tex`, follow `\bibliography{...}` to the `.bib`, or harvest
`\bibitem` blocks if the bibliography is inline; in `.md`, take the `## References` section.

**Scan `note` and `url` fields for a `RePEc:` pattern first.** Any handle you recover
upgrades that entry to a guaranteed `handle_match` and sidesteps the entire year-sensitivity
problem below. This is the single highest-value extraction step.

Derive last names carefully: `Last, First` gives the last name before the comma;
`First Last` gives it after. Getting this backwards is a common cause of false misses.

For each entry build:

| Field | Notes |
|---|---|
| `cite_key` | so the report maps back to the source |
| `author_lastnames` | last names only, **semicolon-separated** — `"Bloom; Liang; Roberts; Ying"` |
| `year` | integer |
| `title` | full title |
| `journal` | optional but improves mismatch detection |
| `handle` | if a RePEc handle is already known — exact-match shortcut |

**Set aside anything pre-1995 or non-article before calling** — books, chapters, theses,
software, pre-1995 classics. Listing them as "not found" is noise. Report them in a separate
"out of corpus scope" section instead.

## Phase 1: Verify

One call, up to 200 entries:

```
verify_references(entries: [ {cite_key, author_lastnames, year, title, journal, handle}, ... ])
```

**Two payload traps, both of which produce a wall of false `not_found`s — check for them
before you believe any negative result:**

1. **Schema is strict** (`additionalProperties: false`); only those six keys exist. A raw
   citation string — `{citation: "Card, D. (1994)..."}` — is silently dropped and every
   entry returns `not_found` with an **empty echoed `entry`**. Empty `entry` objects in the
   response mean you built the payload wrong.
2. **`author_lastnames` must be semicolon-separated.** `"Bloom; Liang; Roberts; Ying"`
   matches; `"Bloom Liang Roberts Ying"` returns `not_found` for a paper that is definitely
   in the corpus. Space-separated names fail silently — this is the easiest way to
   "discover" a shelf of fabricated citations that are all real.

Sanity-check before reporting: if a well-known post-1995 economics paper comes back
`not_found`, re-run that one entry with just a single last name, or with the handle. If it
matches then, your payload was the problem, not the bibliography.

Matching is three-tier: handle → exact year + first author + title keyword → year±1 +
author + first two title words. Each result returns `status`
(`handle_match` | `fuzzy_match` | `loose_match` | `not_found`), the matched `paper`,
citation `stats`, and `mismatches`.

**Year drives everything.** Verified behaviour on a paper known to be in the corpus:

| What you send | Result |
|---|---|
| `handle` | `handle_match` |
| correct year | `fuzzy_match` (+ `mismatches` for a wrong journal) |
| year ±1 | `loose_match` |
| year off by ≥2 | **`not_found`** |
| no `year` at all | **`not_found`** |

Two consequences you must design around:

- **Always send a year.** Omitting it matches nothing, even with an exact title.
- **A wrong year masquerades as a missing paper.** Since journal/author mismatches are only
  reported once the year is close enough to match, the single most common real defect — a
  wrong year in the `.bib` — surfaces as `not_found`, i.e. as if the paper did not exist.

So **never report `not_found` without a second pass**: re-check those entries with
`keyword_search` on distinctive title words and **no year filter**. Leave `fields` at its
default (`title`) — the pass depends on title-word matching, and searching abstracts returns
noise. If the paper turns up, the citation is real and the *year is wrong* — a mismatch to
fix, not a fabrication. This second pass is mandatory, not optional.

Treat `loose_match` as *provisional* — confirm the returned title really is the cited work.
A year±1 hit on a common title can be a different paper.

## Phase 2: Cross-reference the search log

If `found_handles.csv` exists in the literature directory, tag each verified entry with
whether it was previously surfaced by a `lit-search` run. Two useful signals:

- **verified but never searched** — cited without ever appearing in a search; worth a look
- **searched but never cited** — high-impact papers surfaced before and left out

## Phase 3: Write the report

Write to `bib_check_<date>.md` in the literature directory, in this order:

**Summary** — counts by status, plus how many were set aside as out of scope.

**Section A — Could not verify** (highest priority). Per entry: cite key, the citation, the
likely reason, and **what the `keyword_search` second pass returned**. Split it:

- *title found under a different year* → this is a wrong-year mismatch; give the correct year
- *nothing found, in scope, post-2000* → flag for manual check, worded as unverified

Recommend a manual check; do not accuse.

**Section B — Metadata mismatches.** Cited vs corpus value, field by field. Year and journal
mismatches are usually a working-paper/published-version split — say so, and give the handle
and correct metadata so the user can fix the `.bib`.

**Section C — Verified**, with citation counts and percentile, plus the "in search log?"
column when the CSV was found.

`citation_percentile` runs **0–1** (0.9 = top 10%). Flag entries below ~0.1 only where a
better-known paper plausibly belongs instead — and **never flag a paper under ~3 years old**,
where a low count is expected rather than a signal. Slandering recent work is the classic
failure mode here.

**Section D — Out of corpus scope.** The pre-1995 and non-article entries you set aside, so
the user can see they were considered, not skipped silently.

## Phase 4: Report back

Lead with what needs action: unverifiable entries first, then mismatches. State plainly how
many entries were checked, how many were out of scope, and how confident each verdict is.
If a `loose_match` is doing real work in the report, say it is provisional.

## Notes

- 200 entries per call — batch a longer bibliography and merge the results.
- Working-paper vs published-version splits are the most common mismatch; the corpus holds
  both, and `version_links` means either may match.
- Citation counts are **within-corpus** internal counts alongside totals — a low internal
  count on an interdisciplinary paper is expected, not a red flag.
- Never edit the user's `.bib` unless asked. Report, and offer the fix.
