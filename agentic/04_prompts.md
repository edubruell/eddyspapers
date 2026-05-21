# Agentic Search — Prompts & Context Engineering (Note 4)

**Companion to:** `00_overview.md`, `01_design.md`, `02_implementation_plan.md`, `03_interface.md`.
**Scope:** how each model call is assembled — what's cached, what's injected per-run, what shape the model must return — so the hosted agent reproduces the *feel* of the `lit-search` Claude Code skill (which is the reference user-experience) without its filesystem assumptions.

The `lit-search` skill works because the model is given **precise, opinionated, domain-rich context** in a fixed shape: a phase plan, a journal-category reference, a semantic-query writing guide, mandatory boilerplate, and a synthesis schema. Reproducing that *feel* in a hosted setting means treating prompt assembly as a first-class design surface, not a string-concatenation afterthought.

This note covers four stages of the pipeline (`clarify`, `write`, `validate`, `synthesize`) plus the MCP system prompt. `validate` is mostly mechanical (no LLM in the happy path) but its rejection message *is* a prompt input into the next `write` attempt.

---

## 1. Principles

1. **Cache the static, inject the dynamic.** Stage-level prompts (the API reference, the few-shots, the journal reference, the synthesis style guide) are stable across users and live in `agentic_backend/src/prompts/` as TS constants. Each is sent as a content block with `providerOptions.openrouter.cacheControl = { type: "ephemeral" }`, so a warm cache returns at fractional cost. The user's brief, the script, and the run's structured results are the only things that change per call.

   **Caching is the whole reason this service is affordable, and it is conditional.** OpenRouter passes provider-native caching through but only for a specific allowlist of models (see `02_implementation_plan.md` §2.1). For cheap defaults (`qwen3-coder-flash`, `deepseek-v3.2`) cached reads are ~0.25× input price; for Haiku 4.5 they're 0.1×. For any model *not* on the allowlist, the 4–5k token system prompt is paid in full on every call and the economics collapse. Two hard rules follow:
   - **Every model in `agent/models.ts` must be on the OR caching allowlist** unless explicitly justified as a one-shot quality fallback that runs <5% of the time.
   - **Cache hits must be verified, not assumed.** Every dev-mode call logs `prompt_tokens_details.cached_tokens` and the pipeline prints `cached / total` per stage. A model that "supports caching" but fails to hit through OR (there are open issues against `@openrouter/ai-sdk-provider` about this) is disqualified at benchmark time.
   - TTL is 5 min on Qwen/DeepSeek; the system stays warm via traffic, not infrastructure. The cached block ordering matters — put the largest stable assets first so a partial-hit covers the most tokens.

2. **The model sees no infrastructure.** No DB paths, no snapshot locations, no internal IDs, no `eddyspapersbackend::` package paths. The R sandbox makes the `eddysearch.sandbox` verbs feel like the *only* world. This is the same discipline as `lit-search` (which never tells the model where `/Users/ebr/eddyspapers/` lives — it just provides `Sys.setenv(...)` boilerplate).

3. **Every rule comes with a one-line *why*.** Models follow rules more reliably when they understand them. "No `library()` — the verbs are pre-attached, and `library()` would let you load packages outside the allowlist" is twice as durable as just "no `library()`".

4. **Worked examples > rule lists.** The single most leverageable thing in the `lit-search` skill is the **mandatory boilerplate block** + **section templates**. We port those near-verbatim into the writer's few-shots, adapted to the `emit_*` API.

5. **Structured output where the schema is small; free-form where the schema is the prose itself.** The writer emits `{ script: string }` via `generateObject`; the synthesiser streams free markdown. The clarifier emits either `{ done: true }` or `{ done: false, question: string }`.

6. **Token budget per stage is fixed.** If we blow the budget on context, prompt caching savings disappear. Approximate targets:

   | Stage | Cached system | Per-call user/assistant | Streamed output |
   |---|---|---|---|
   | clarify | ~1.5k | ~0.3k | ~0.2k |
   | write | ~4–5k | ~1k | ~1k |
   | synthesise | ~2k | ~6–10k (results JSON) | ~2–4k |

   The writer's cached block is the biggest single asset — the API ref + few-shots — and the biggest cost lever.

---

## 2. The cached corpus (the writer's "skill brain")

Everything in this section lives in `agentic_backend/src/prompts/` as TS constants, assembled once at boot, sent as a single cached system message with each writer-stage call.

### 2.1 `apiReference.ts` — the `eddysearch.sandbox` surface

Mirrors design §3.2 / §3.3. For each verb: one-line semantics, full signature, return shape, 1–2 idiomatic uses. Grouped: **data verbs**, **output verbs**, **base-R/dplyr/stringr/purrr glue you may use**, **what's forbidden and why**.

Shape (excerpt):

```
## Data verbs

semantic_search(query, max_k = 30, min_year = NULL,
                journal_filter = NULL, journal_name = NULL) -> tibble
  Vector search over the articles DB. `query` is dense prose (3–6 sentences),
  not keywords (see "Semantic query writing"). `journal_filter` is a comma-string
  of category names; `journal_name` matches exact journal text. Returns columns:
  Handle, title, year, authors, journal, category, abstract, similarity, bib_tex.

sql_query(sql, params = list()) -> tibble
  Read-only SELECT against {articles, cit_all, cit_internal, handle_stats,
  journals, versions, bib_coupling}. Validated at the DuckDB parser level —
  COPY/ATTACH/PRAGMA/CREATE/DDL all rejected. LIMIT auto-injected if absent.
  Use for keyword chains like:
    LOWER(title) LIKE '%xxx%' OR LOWER(authors) LIKE '%name%'
  …
```

The reference is the single source of truth — when the schema changes, this file changes, and every prompt automatically picks it up.

### 2.2 `journalCategories.ts` — the ZEW ranking, verbatim from `lit-search`

The big table in `lit-search/SKILL.md` (Top 5, AEJs, Top Field A, General Interest, Second in Field B, Other, Working Paper Series) ports across **unchanged**, including the per-journal counts and the "Notes on Working Paper Series" / "Notes on General Interest" paragraphs. This is irreplaceable domain context — without it the model picks the wrong filters.

### 2.3 `semanticQueryGuide.ts` — the prose-not-keywords lesson

Direct port of the lit-search §"Semantic query writing" block:

- Describe the **mechanism or phenomenon**, not just the topic label
- Include **method words** if relevant (quasi-experimental, RCT, IV, matched panel)
- Include **context** if relevant (Germany, refugees, IAB data)
- Each SEM section should vary the framing
- Bad/Good examples in full

This is one of the most leverageable sub-prompts the skill has; the hosted writer gets it identically.

### 2.4 `examples.ts` — three full worked scripts

Few-shots are the most reliable way to teach a model the *shape* of a good script. Three examples, each ~80–120 lines, mirroring the patterns in `lit-search`:

1. **Topic + journal-scan combo** — a keyword SQL sweep over Top 5/Field-A, plus 2 semantic sections varying the framing, plus a WP scan. Ends with `emit_bibtex(all_handles)`.
2. **Active-authors + editor-targeting** — `sql_query` chains over `authors LIKE '%lastname%'` for a curated list of editors, plus a semantic section per editor's main area, plus a coauthor-network section using `cit_internal`. (The skill calls this Mode E.)
3. **Single-journal exhaustive** — `journal_name = "Journal of Labor Economics"` for the semantic side, plus a brute-force `LOWER(journal) LIKE '%journal of labor economics%' AND LOWER(title) LIKE '%kw%'` SQL chain.

Each example has a `### Brief` block at the top (the natural-language input it was written for) so the model learns brief → script mapping directly.

### 2.5 `writerRules.ts` — the hard rules + their *why*

```
- Never call `library()`. The verbs you need are pre-attached. Loading other
  packages is blocked by the AST checker and would only waste a retry.
- Never call `cat`/`writeLines`/`write.csv`. Emit results with
  `emit_section()`, `emit_note()`, `emit_bibtex()`. The orchestrator turns
  these into wire events the UI renders live.
- `sql_query()` is SELECT-only against the listed tables. Anything else is
  parser-rejected. Don't try to use it for COPY/ATTACH.
- `max_k` per semantic call: keep ≤ 30 for top-N sweeps, ≤ 15 for WP/recent.
  Per-section `LIMIT` on SQL: ≤ 200. Larger limits are auto-truncated and
  waste tokens.
- Always finish with `emit_bibtex(all_handles)`. The synthesiser uses this.
- Accumulate handles into a local `all_handles` vector as you go.
```

Each rule is one line followed by one short *why* clause. Order: hard prohibitions first, then numeric caps, then required steps.

---

## 3. Per-run context — what gets injected on each writer call

The user message to the writer stage is **just three blocks**:

```
<brief>
{the user's task text, verbatim — never paraphrased}
</brief>

<filters>
categories: {comma-list from the category pills}
min_year:   {optional, from advanced filters}
must_include: {handles or author names the caller said must appear, if any}
</filters>

<db_snapshot>
2026-05-16   # last successful update_repec.R run
</db_snapshot>
```

Nothing else. The cached system message has done the heavy lifting; the per-run injection is small and entirely user-derived.

When the writer retries after a validation failure, a fourth block is appended:

```
<previous_attempt>
{the script that was rejected}
</previous_attempt>

<rejection>
{the AST checker's reason + offending node}
</rejection>
```

This is the same pattern as Claude Code's `error` → retry loop and is what makes the AST checker a teacher rather than a brick wall.

---

## 4. The clarifier stage — fast and bounded

### 4.1 Cached system prompt (~1.5k tokens)

- The same `journalCategories.ts` block (the model needs it to judge whether to ask about category scope).
- A small "**Modes**" block listing topic / journal-scan / active-authors / recent-WP / editor-targeting with a one-line description of each.
- The clarifier policy:
  - Ask **at most one** question.
  - Don't ask about anything inferable from the brief.
  - Don't ask generic survey questions; tailor to *this* brief.
  - If the brief is clear (modes obvious, scope implied, no must-include constraints), reply `{done: true}` immediately.

### 4.2 Structured output schema

```ts
const clarifierOutput = z.discriminatedUnion("done", [
  z.object({ done: z.literal(true) }),
  z.object({ done: z.literal(false), question: z.string().max(280) }),
]);
```

### 4.3 MCP behaviour

Over MCP, `skip_clarify = true` by default (design §7.3). The clarifier still runs, but instead of asking, it must produce `{done: true}` *plus* a `needs_clarification?: string[]` field surfaced in the tool result when the brief is genuinely ambiguous. Web vs. MCP behaviour diverges at this one schema field; the model's job is the same.

---

## 5. The synthesiser stage — replicate the skill's literature-review voice

### 5.1 Cached system prompt (~2k tokens)

- The **synthesis format block** from `lit-search/SKILL.md` §"Synthesis format", verbatim: Overview → Key Papers → Implications. Same headings, same lengths, same selection principles.
- The **selection principles** block:
  - Prefer causal identification over descriptive
  - Prefer Top 5 / Top Field (A) unless a WP is clearly central
  - Prioritise 2020+ for recency, include foundational older papers where necessary
  - Only cite papers whose abstracts appear in the input
  - Do not fabricate; flag truncated abstracts
  - Flag WP/published duplicates
- A one-paragraph **voice guide**: minimal, direct, no generic survey prose, every sentence serves the brief.
- **Citation linking — mandatory.** Every time you cite a paper in the prose, format it as a real markdown link to the paper's `url` field:

  ```
  [Author Year](url)             →  e.g. [Card & Krueger 1994](https://doi.org/10.1257/aer.110.5.1235)
  [Author et al. Year](url)      →  for 3+ authors
  ```

  The `url` for every cited paper is in the `<papers>` JSON block. It already resolves in order of preference to (1) the journal/publisher page or DOI, (2) the working-paper series page (NBER/IZA/CESifo/…), or (3) an IDEAS/RePEc page as fallback. The model does not need to know which tier it came from — just use `url` verbatim. **Never invent URLs, and never substitute `https://ideas.repec.org/…` for a paper that already has a publisher URL.** If a paper has no `url` (rare), cite it without a link and add the handle in backticks (`` `RePEc:…` ``) so the frontend can still anchor-link it. The frontend rewrites all external markdown links to `target="_blank"` automatically, so the reader can open papers without losing their place. Bare handle substrings (`` `RePEc:…` ``) inside the prose also auto-linkify to the in-page evidence card and are the right choice when you want to point at the local section, not the external page.

  Rule of thumb: **external link on the citation itself, handle backticks only when referring to "the section above"** or when no URL exists.

### 5.2 Per-call user message

```
<brief>{the brief verbatim}</brief>

<script>{the validated R script, for the model's awareness of what was searched}</script>

<sections>
[JSON array of Section records — id, title, mode, query/sql, n_total, n_shown,
 rows with handle + rank + similarity]
</sections>

<papers>
[JSON object: { [handle]: Paper } — the full record per handle, deduped]
</papers>

<bibtex>
[full .bib string for context, so the model can reference numbered keys if useful]
</bibtex>
```

The synthesiser sees **everything** the user would download. The cached style guide tells it how to compress that into the deliverable.

### 5.3 Streaming

Use `streamText` so tokens hit the SSE stream as soon as the model produces them. The frontend renders markdown live (`react-markdown` + `remark-gfm`). No JSON envelope — the channel for this stage is prose.

---

## 6. Validator (no LLM in the happy path)

`validate` is the AST allowlist (`agentic/r/check.R`). It is not a prompt — but its **error messages are**, since they become input to the writer's retry. So we treat the rejection format as part of the prompt surface:

```
{
  ok: false,
  reason: "Function `system()` is not on the allowlist.",
  offending_node: "system(\"ls /etc\")",
  hint: "Remove this call. If you needed to list tables, use `journals()` or
         `categories()` instead. If you genuinely need shell access, the
         agentic sandbox does not provide it by design."
}
```

Three discipline rules for these messages:

1. **Name the rule, not just the symbol.** "Function `system()` is not on the allowlist" beats "syntax error".
2. **Point at the offending fragment** so the model doesn't have to guess where.
3. **Suggest the legal alternative**, when there is one. This is what closes the retry loop fast.

A rejection-reason taxonomy lives in `check.R` and is unit-tested against a corpus of "things models try" (a growing fixture seeded with: `library()` calls, `cat()` to a file, `eval(parse(...))`, raw `DBI::dbConnect`, `do.call("system", …)`, etc.).

---

## 7. The MCP system prompt

The MCP `lit_search` tool reuses `runAgent.ts` and therefore reuses every prompt above. **The only MCP-specific prompt addition** is appended to the writer's cached system block when invoked over MCP:

```
You are being called via MCP by another coding agent, not by an interactive
human. Optimise for:
- One-shot success: the caller cannot easily re-prompt you.
- Comprehensive section coverage: the calling agent will not "see" your sections
  one by one — they receive a single bundle at the end.
- Self-contained synthesis: assume the calling agent will paste the synthesis
  directly into a paper or note without further editing.
```

That's it. Same pipeline, same cache, just a tighter goal-statement.

---

## 8. How this reproduces the `lit-search` skill *feel*

Side-by-side, what the skill does and where the hosted agent matches it:

| `lit-search` phase | Where it lives here |
|---|---|
| Phase 0: Orient — read `local_context/notes/`, prior searches | Replaced by the `<brief>` + UI category-pill filters; no filesystem orient in a hosted setting. The MCP variant trusts the calling agent to have done its own orient. |
| Phase 1: Ask clarifying questions, tailored | `clarify` stage (§4). One question max, schema-bounded. |
| Phase 2: Mandatory boilerplate + section templates | Cached few-shots (`examples.ts`, §2.4) + the `eddysearch.sandbox` API ref (§2.1). The "boilerplate" becomes the package's default state — the model doesn't write the `library(...)` lines; they're pre-attached. |
| Phase 2: Journal-category reference | `journalCategories.ts` (§2.2), verbatim. |
| Phase 2: Semantic query writing guide | `semanticQueryGuide.ts` (§2.3), verbatim. |
| Phase 2: Mandatory BibTeX export | A required `emit_bibtex(all_handles)` rule (`writerRules.ts`, §2.5). |
| Phase 3: Ask user to run | Skipped — the sandbox runs automatically. The "Ollama must be running" caveat is moot because the hosted box guarantees it. |
| Phase 4: Synthesise to `lit_[slug].md` | `synthesize` stage (§5), with the exact same heading layout and selection principles. Output streams to the UI live; same content is the `report.md` artifact. |

The skill's `found_handles.csv` master log has no direct analogue — that pattern only makes sense when many searches accumulate in one project directory. The agentic equivalent is the `searches` cache table (`02_implementation_plan.md` §3), which is invisible to the model but enables history/share/dedup.

---

## 9. Iteration & evaluation

Two evaluation harnesses live in `agentic_backend/tests/`:

1. **`tests/ast/`** — corpus of (a) every real lit-search script Eddy has run (must validate) and (b) adversarial scripts (must reject with helpful messages). New rejections from prod get auto-added to the adversarial corpus.

2. **`tests/agent/`** — ~50 representative briefs replayed with mocked LLM outputs to assert:
   - the cached system is well-formed and within budget,
   - the per-call injection contains no infra leaks,
   - retries are surfaced to the writer with the rejection reason intact,
   - the synthesiser receives a `papers` map that's deduped and complete.

Cost benchmarking (model selection in `02_implementation_plan.md` §2.1) reuses the same 50 briefs against each candidate model and prints a per-stage $/run table.

---

## 10. Open questions specific to prompts

1. **Should the writer see prior runs of the same brief?** Today: no — every run is fresh. Pro: deterministic, cacheable by `search_id`. Con: misses an opportunity to learn from a previous validated script. Probably stay deterministic.
2. **Does the synthesiser need the script?** Currently included for "awareness of what was searched". Worth ablating — if removing it doesn't degrade synthesis quality, we save ~1k tokens per call.
3. **Per-language synthesis.** German-speaking users may want German output. Trivial to add (one extra cached style block + a `lang: "de"|"en"` brief flag). Defer until requested.
4. **Voice tuning for cover letters vs. related-literature sections.** The lit-search skill's "purpose" question (`paper/grant/cover-letter`) shapes the synthesis. We could surface this as a small select in the UI's advanced filters — or infer from the brief. Inference is cheaper; test it first.
