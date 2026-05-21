# Agentic Search — Design Note

**Target:** `agenticsearch.eduard-bruell.de`
**Stack:** TypeScript orchestrator + sandboxed R script execution against `eddyspapersbackend`
**Inspiration:** the existing `lit-search` skill, but exposed as a hosted, multi-turn web service.

---

## 1. Core idea

`lit-search` works because the model *writes a small R search script*, runs it against the local DuckDB, then synthesises a literature review from the structured output. We replicate that exact pattern — **not** a tool-call loop — for two reasons:

1. R scripts are far more expressive than a fixed tool schema (joins, ranking heuristics, deduping by version, filtering by handle prefix, custom percentile cuts). A tool-calling agent would need a dozen brittle endpoints to match what a 30-line R script does naturally.
2. One scripted query against a local DuckDB is cheap and fast; an iterative tool loop racks up model tokens and round-trips.

The price we pay is **arbitrary code execution from an LLM**, so the entire design hinges on a hardened sandbox.

---

## 2. Pipeline

```
User query
   │
   ▼
[Clarifier]      ── cheap model, 0–1 turns, asks at most one question
   │
   ▼
[Script writer]  ── cheap model + cached API reference, emits R script
   │
   ▼
[Static check]   ── AST allowlist, hard reject on violation
   │
   ▼
[Sandbox exec]   ── Rscript subprocess, read-only DB, no net, ulimits
   │
   ▼
[Synthesiser]    ── cheap model, takes JSON result + brief, writes review + .bib
   │
   ▼
SSE stream to browser
```

All four model calls go through the same provider abstraction (Vercel AI SDK + `@openrouter/ai-sdk-provider`) so we can swap models per-stage via config. Candidate models and the constraints they sit under are owned by `02_implementation_plan.md` §2.1 — concrete picks settle at benchmark time, not in this doc.

---

## 3. The sandbox — defused R

The constraint set comes from the redesigned `lit-search` skill: real scripts are not three-line tool calls. They mix `semantic_search()` with **raw `DBI::dbGetQuery` SQL** (year+category+`LIKE '%keyword%'` chains, `IN (...)` lists built with `paste0`+`gsub` escaping), **define local helper functions** like `fmt_results`, **loop over result rows** to format output, use a non-trivial dplyr/stringr/base-R glue layer, and **write files** (`.md` sections, `.bib`, `.csv` handles log).

We need to keep all of that expressiveness — keyword chains are the single most important search mode after semantic — while removing the file/network/eval surface.

### 3.1 Three-layer defence

1. **Curated R package** `eddysearch.sandbox`: pre-loaded into the R session, provides the data verbs and the *only* sanctioned way to talk to the DB. No `library()` in user scripts — the package is attached for them.
2. **Static AST allowlist** on the generated script before execution.
3. **Process-level hardening** (systemd, namespaces, ulimits, read-only DB).

### 3.2 The `eddysearch.sandbox` package

Pre-attached. Exposes:

**Data verbs**
- `semantic_search(query, max_k = 30, min_year = NULL, journal_filter = NULL, journal_name = NULL)` → tibble — proxy for the existing function with identical semantics.
- `sql_query(sql, params = list())` → tibble — runs **read-only, parse-validated SQL** against the articles DB (see §3.4). Parameter binding supported; the model is *taught* to use it but can also pass literal strings (we validate either way).
- `cites(handle, limit = 50)`, `citedby(handle, limit = 50)`, `handle_stats(handles)`, `versions(handle)`, `bib_for(handles)` → tibbles.
- `journals()`, `categories()` → reference tibbles so the model can discover values without guessing.

**Output verbs** (replace `cat(file=…)` / `writeLines` entirely)
- `emit_section(title, df, n = 25, note = NULL)` — appends a labelled result section to the in-memory report buffer.
- `emit_bibtex(handles)` — accumulates handles for a final BibTeX bundle.
- `emit_note(markdown)` — free-form markdown commentary between sections.

A run produces no files; the package collects everything in process state and the runner serialises `{ sections, bibtex, notes, stats }` as the JSON result. The orchestrator decides what to render and what to expose to the synthesiser model. This deletes the entire "where can scripts write?" question.

**Helper exports**
- `fmt_row(df, i)` and a default `format_results()` — so the model rarely needs to write its own formatter, but *can*.

### 3.3 AST allowlist — concrete

Parse the script with `parse(text = ...)`, walk every node, classify.

**Allowed node shapes**
- Literals, symbols, `<-` and `=` assignment (local only).
- `if`/`else`, `for`, `while`, `repeat`, `break`, `next`, `{ }`, `lapply()` blocks.
- Function definitions `function(args) body` (body recursively validated).
- Operators: `+ - * / %% %/% ^ == != < <= > >= & | && || ! : %in% %*%`.
- The base pipe `|>` and the magrittr pipe `%>%` (binding to `magrittr::%>%` only).
- Indexing: `[`, `[[`, `$`.

**Allowed function calls** — split by namespace and behaviour:

*Base R glue (the long tail that makes scripts feel like R)*
`c, list, vector, character, numeric, integer, logical, double, complex, data.frame, matrix, array, tibble`
`length, nrow, ncol, dim, names, colnames, rownames, NROW, NCOL`
`seq, seq_len, seq_along, rev, sort, order, rank, unique, duplicated, which, any, all, table`
`paste, paste0, sprintf, format, formatC, prettyNum, toString`
`tolower, toupper, trimws, substr, substring, startsWith, endsWith, strsplit, chartr, nchar, nzchar`
`gsub, sub, grepl, grep, regmatches, regexpr, gregexpr`
`abs, sign, round, signif, floor, ceiling, trunc, exp, log, log2, log10, sqrt, min, max, sum, prod, cumsum, mean, median, quantile, sd, var, cor, range, pmin, pmax`
`is.na, is.null, is.numeric, is.character, is.logical, is.integer, is.double, is.finite, is.function, is.list, is.data.frame, inherits`
`as.character, as.numeric, as.integer, as.logical, as.Date, as.POSIXct`
`Sys.Date, Sys.time, format.Date, difftime, as.Date.character`
`head, tail, rev, append`
`setdiff, union, intersect, match`
`Reduce, Map, Filter, Find, Position, mapply, vapply, sapply, lapply, do.call` (`do.call` only with a literal function-name string; rejected otherwise)
`print, message, warning, stop` (stdout is discarded anyway)
`identity, invisible, structure, attr, attributes` (attribute writes other than names blocked)
`tryCatch, try, withCallingHandlers, on.exit, simpleError, simpleCondition`

*dplyr / tibble*
`filter, mutate, select, arrange, desc, slice, slice_head, slice_tail, slice_min, slice_max, slice_sample, distinct, group_by, ungroup, summarise, summarize, count, tally, pull, rename, relocate, transmute, rowwise`
`left_join, inner_join, right_join, full_join, anti_join, semi_join, cross_join`
`bind_rows, bind_cols`
`case_when, if_else, coalesce, na_if, between, near`
`n, n_distinct, row_number, cur_group_id, lag, lead`
`across, where, everything, starts_with, ends_with, contains, matches, all_of, any_of, last_col`
`as_tibble, tibble, tribble, glimpse`

*stringr*
`str_detect, str_subset, str_which, str_count, str_extract, str_extract_all, str_match, str_match_all, str_replace, str_replace_all, str_remove, str_remove_all, str_to_lower, str_to_upper, str_to_title, str_to_sentence, str_trim, str_squish, str_pad, str_trunc, str_split, str_split_fixed, str_c, str_length, str_starts, str_ends, str_glue, fixed, regex, coll, boundary`

*tidyr* (smaller surface; only the obvious shape-changers)
`pivot_longer, pivot_wider, separate, separate_rows, unite, replace_na, drop_na, fill, nest, unnest, unnest_longer, unnest_wider, expand_grid, crossing`

*purrr* (we already prefer purrr over loops in this project)
`map, map_chr, map_dbl, map_int, map_lgl, map_dfr, map_dfc, map2, map2_chr, map2_dbl, pmap, pmap_chr, pmap_dbl, walk, walk2, keep, discard, compact, flatten, flatten_chr, flatten_dbl, reduce, accumulate, set_names, possibly, safely`

*Package surface*
All exports of `eddysearch.sandbox` (data verbs + output verbs + helpers).

**Hard-rejected calls** — anything not on the list, plus an explicit blocklist for clarity in error messages:

`system, system2, shell, pipe, file, url, socketConnection, gzfile, bzfile, xzfile, unz, connection, download.file, curl_download`
`library, require, requireNamespace, loadNamespace, attachNamespace, attach, detach`
`source, sys.source, parse, eval, evalq, body, formals, as.function, match.fun, Recall`
`get, get0, mget, getFromNamespace, getNamespace, asNamespace`
`assign, delayedAssign, makeActiveBinding, lockBinding, lockEnvironment, new.env, globalenv, baseenv, parent.frame, parent.env, sys.call, sys.function`
`Sys.setenv, Sys.unsetenv, Sys.setlocale, setwd`
`unlink, file.remove, file.rename, file.create, file.copy, file.symlink, dir.create, dir.remove`
`writeLines, write.csv, write.table, write.csv2, write, saveRDS, save, save.image, sink, capture.output, cat` *(cat blocked entirely — model uses `emit_section`/`emit_note`)*
`readLines, read.csv, read.table, readRDS, load, scan, readBin, readChar`
`Rcpp::, dyn.load, dyn.unload, library.dynam, .Call, .External, .Internal, .Primitive, .C, .Fortran`
`quit, q, options(error = …), traceback, browser, debug, undebug, debugonce, trace, untrace`

**Other AST rules**
- `<<-` rejected (no global writes).
- `::` allowed only for `magrittr::%>%`; `:::` always rejected.
- `do.call` requires a literal string or symbol resolvable in the allowlist as its first argument.
- `assign`/`get` rejected outright — local `<-` covers every legitimate case.
- String literals are scanned for: absolute paths outside `/tmp/sandbox-out/`, URLs (`https?://`, `ftp://`), shell metacharacters in suspicious positions (`$(`, backticks, `;`, `&&` outside SQL contexts) — *warnings*, not auto-rejects, because SQL strings legitimately contain `;` and `&`. Final SQL is validated separately at `sql_query()` time.

The check returns either `{ ok: true }` or `{ ok: false, reason, offending_node }` and the orchestrator surfaces the reason back to the writer model for a retry.

### 3.4 SQL safety inside `sql_query()`

Raw SQL is non-negotiable for keyword search expressiveness. We defuse DuckDB itself:

**At connection open**
```r
DBI::dbExecute(con, "SET disabled_filesystems = 'LocalFileSystem,HTTPFileSystem,S3FileSystem'")
DBI::dbExecute(con, "SET autoinstall_known_extensions = false")
DBI::dbExecute(con, "SET autoload_known_extensions = false")
DBI::dbExecute(con, "SET allow_unsigned_extensions = false")
DBI::dbExecute(con, "SET enable_external_access = false")
DBI::dbExecute(con, "SET lock_configuration = true")
```
Connection is `read_only = TRUE` against a snapshot file.

**Per-query validation** (inside `sql_query()`)
1. Call `duckdb::dbGetQuery(con, "SELECT json_serialize_sql($1)", list(sql))` to get the parse tree.
2. Walk the JSON tree:
   - Top-level statement must be `SELECT_NODE` or `SET_OPERATION_NODE` (UNION/INTERSECT/EXCEPT over SELECTs).
   - Reject any `ATTACH`, `COPY`, `EXPORT`, `IMPORT`, `INSTALL`, `LOAD`, `PRAGMA`, `CALL`, `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `VACUUM`, `CHECKPOINT`.
   - Walk function-call nodes; reject any function whose name matches `read_csv*`, `read_parquet*`, `read_json*`, `read_blob`, `glob`, `parquet_*`, `sniff_csv`, `sql_auto_complete`, `query_table`, anything in the `httpfs`, `aws`, `azure`, `iceberg` schemas, plus `system`, `getvariable`, `setvariable`.
   - Reject references to tables outside the allowed schema (`articles`, `cit_all`, `cit_internal`, `handle_stats`, `journals`, `versions`, `bib_coupling`, plus any views we publish).
3. If no `LIMIT` clause is present in the outermost SELECT, inject `LIMIT 5000` before execution.
4. Set `SET statement_timeout = '15s'` for the session.

This means the model can write the kind of `LOWER(title) LIKE '%keyword%' OR LOWER(authors) LIKE '%name%'` chains lit-search relies on, and we still reject `COPY (SELECT *) TO '/tmp/dump.csv'` or `ATTACH 'https://evil/...'`.

### 3.5 Process-level hardening (unchanged from v1, tightened)

- `Rscript --vanilla` — no Rprofile, no Renviron, no site library.
- Dedicated unprivileged user `eddysandbox`; no sudo, no shell.
- `systemd-run --scope --uid=eddysandbox` with:
  `MemoryMax=1G`, `CPUQuota=200%`, `TasksMax=32`,
  `PrivateNetwork=yes` (DB is local — kills any residual exfil path),
  `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ProtectKernelModules=yes`, `ProtectKernelTunables=yes`, `RestrictNamespaces=yes`, `RestrictSUIDSGID=yes`, `NoNewPrivileges=yes`,
  `ReadOnlyPaths=/var/lib/eddysearch/snapshot.duckdb`,
  `ReadWritePaths=` (empty — no fs writes anywhere).
- Wall-clock timeout 30s via `timeout(1)`.
- DuckDB opened `read_only = TRUE` on a **bind-mounted, read-only copy of the most recent updated DB file** (re-pointed by `update_repec.R` after each weekly/monthly sync — see `02_implementation_plan.md` §3). The copy exists so a live update never races with the sandbox; it is not a nightly cron snapshot.
- Result comes back on FD 3 as a JSON blob; stdout/stderr captured for debug only, capped at 256 KB. JSON result capped at ~2 MB; `emit_section` truncates per-row.

### 3.6 What the model is told

System prompt (cached) contains:
- The full `eddysearch.sandbox` API reference with signatures + 1-line semantics per function.
- The dplyr/stringr/purrr/base-R verbs available, grouped by purpose.
- A schema reference for `articles` (column list and types) and pointers to `journals()` / `categories()` for value discovery.
- The "modes" taxonomy from lit-search (topic, journal scan, active authors, recent WPs, editor targeting).
- 3–4 worked example scripts mirroring lit-search patterns: KW + SEM, journal-scan, author-lookup.
- Hard rules: "no `library`", "no `cat`/`writeLines`/`write.csv` — use `emit_*`", "no file paths in strings", "every `sql_query()` must be `SELECT`-only over the listed tables", "bound `LIMIT`/`max_k` to ≤ 200 per section".
- A short rationale for *why* each rule exists, because models follow rules better when they understand them.

The model never sees the DB path, snapshot location, or any infra detail.

---

## 4. Streaming protocol & structured output

The R script takes 10–30 s; synthesis takes another 5–15 s. Without progress, the UI hangs. The whole pipeline streams **typed events** to the browser, and the frontend turns them into stage indicators, spinners, partial result cards, and finally the synthesised review.

### 4.1 Transport

Server-sent events over the `/chat/:id/stream` endpoint. One JSON object per SSE `data:` line, named events via `event:`. Heartbeat ping every 15 s so Caddy/Nginx don't drop the connection. Each event carries a monotonic `seq` so the client can detect gaps if it reconnects.

### 4.2 Stage model

A run moves through five stages — the UI shows them as a horizontal stepper, with the active stage spinning and prior stages checkmarked:

```
clarify → write → validate → execute → synthesize
```

Every stage emits a `stage` event on entry and exit, plus finer-grained events while active:

| Stage      | While active                                                |
|------------|-------------------------------------------------------------|
| clarify    | streamed assistant tokens (one optional clarifying turn)    |
| write      | streamed R script tokens into a collapsible code panel      |
| validate   | one-shot pass/fail; on fail, retry counter increments       |
| execute    | progress events from inside R (per data-verb call) + sections as they're produced |
| synthesize | streamed markdown tokens into the prose panel               |

### 4.3 Event types (TypeScript)

```ts
type StreamEvent =
  | { type: "stage";       seq: number; stage: Stage; state: "enter"|"exit"; ms?: number }
  | { type: "assistant";   seq: number; stage: Stage; delta: string }      // streamed tokens (clarify, synthesize)
  | { type: "script";      seq: number; delta: string }                    // streamed R script during `write`
  | { type: "validate";    seq: number; ok: boolean; reason?: string; offending?: string }
  | { type: "progress";    seq: number; label: string; current?: number; total?: number }
  | { type: "section";     seq: number; section: Section }                 // a completed result block
  | { type: "paper";       seq: number; paper: Paper }                     // canonical record, one per handle
  | { type: "bibtex";      seq: number; entries: number; bibtex: string }
  | { type: "synthesis";   seq: number; delta: string }                    // alias of assistant during synthesize, kept separate for clarity
  | { type: "error";       seq: number; where: Stage; message: string; recoverable: boolean }
  | { type: "done";        seq: number; ms_total: number };

type Stage = "clarify" | "write" | "validate" | "execute" | "synthesize";
```

### 4.4 Structured output schemas

```ts
interface Section {
  id: string;                       // "kw-1", "sem-2", "wp", "authors-johnson"
  title: string;                    // "Bureaucratic quality — keyword sweep"
  mode: "keyword" | "semantic" | "journal_scan" | "author" | "wp" | "editor" | "custom";
  query?: string;                   // semantic query prose, if any
  sql?: string;                     // raw SQL, if any (already validated)
  filters?: {
    min_year?: number;
    journals?: string[];
    categories?: string[];
    journal_name?: string;
  };
  n_total: number;                  // rows the query produced
  n_shown: number;                  // rows in `rows` after truncation
  rows: SectionRow[];               // ranked, ready to render
  note?: string;                    // free-form markdown commentary from the model
}

interface SectionRow {
  handle: string;                   // canonical key — full record lives in a `paper` event
  rank: number;                     // 1-based within section
  similarity?: number;              // cosine distance, if semantic
}

interface Paper {
  handle: string;
  title: string;
  authors: string[];                // split from the comma-joined DB string
  year: number;
  journal: string;
  category: string;
  url: string;                      // resolvable link — publisher/journal page primary, IDEAS fallback (see resolution rule below)
  abstract: string | null;
  bibtex: string;
  stats?: {                         // from handle_stats, only if model requested it
    cites_total?: number;
    cites_internal?: number;
    percentile?: number;
    top5_citer_share?: number;
    cites_by_year?: { year: number; n: number }[];
  };
  versions?: string[];              // sibling handles (preprint ↔ published)
}
```

The `Paper` record is sent **once per handle per run**, the first time it's referenced. Sections carry only `{handle, rank, similarity}` — the frontend joins by handle. This keeps the wire small even when the same paper appears in three sections.

**`url` is mandatory** because the synthesiser uses it to produce real outgoing links inside the prose (see §4.8 and `04_prompts.md` §5). The current DB schema already supports this well, with one gap worth closing:

**What the DB has today** (`backend/R/database.R` + `parse.R`):
- `articles.url` — populated from RDF `file` entries during parse. For published papers this is typically the **publisher/journal landing page** (or direct PDF) — exactly what we want as the primary link. For working papers it's the institution's stable URL (NBER/IZA/CESifo/ZEW PDF/landing). Either way it's a real, working outbound link, not a fallback.
- DOI is parsed from RDF (`entry$doi`) but currently only embedded inside `bib_tex` — **not stored as its own column**.

**Resolution rule for `Paper.url` sent on the wire**, in order of preference:

1. `articles.url` if non-empty — covers the vast majority of papers and is already the publisher or working-paper-series URL.
2. `https://ideas.repec.org/{path-from-handle}` — last-resort fallback derived deterministically from the handle, used only when `articles.url` is empty.

The resolution function (`paper_url(handle)` in `eddysearch.sandbox`) walks these tiers and returns the first hit. In practice almost every paper hits tier 1.

**On DOI as a future tier (deferred).** Adding a `doi VARCHAR` column to `articles` would let us insert `https://doi.org/{doi}` as a clean middle tier. The parse side is trivial — `entry$doi` is already extracted in `parse.R:179-182` and embedded inside `bib_tex` — but populating the column for the existing corpus is not: a full reparse-and-re-embed is unjustified for this alone, and a regex-extract-from-`bib_tex` backfill is doable but needs careful handling of bib_tex variants and edge cases (empty DOIs, escaped braces, multi-DOI fields). **Defer to an unspecified future** when there's a second reason to touch the schema (e.g. lit-check or citation-graph work that also wants a clean DOI). For now, tiers 1 + 2 are good enough — empty-`url` papers are rare, and IDEAS is a perfectly serviceable fallback for those.

### 4.5 How R emits events

`eddysearch.sandbox` opens **FD 3** at startup and writes one JSON line per event. The TS runner reads FD 3 line-by-line and re-emits onto the SSE stream (translating R-side event names into the schema above, adding `seq`).

The model **does not** write progress code manually. Every data verb wraps itself:

```r
# inside the package (sketch)
semantic_search <- function(query, ...) {
  emit_event(list(type = "progress",
                  label = paste0("Semantic search: ", str_trunc(query, 60))))
  t0 <- Sys.time()
  res <- .impl_semantic_search(query, ...)
  emit_event(list(type = "progress",
                  label = paste0("  ↳ ", nrow(res), " results in ",
                                 round(as.numeric(Sys.time() - t0), 1), "s")))
  res
}
```

Same wrapping for `sql_query`, `cites`, `citedby`, `handle_stats`. Inside `emit_section`, the package also:
1. Looks up full `Paper` records for any new handles, emits one `paper` event per new handle, deduped via an in-process set.
2. Emits the `section` event with `rows` referencing those handles by key.

For the model's optional narration: `emit_progress("Pruning to 2020+ in top-5 only…")` is exposed but rarely needed.

### 4.6 Astro / React component map

The chat view is one React island in Astro (`SearchChat.jsx`) that mounts an `EventSource` and dispatches events into a reducer-backed store. The store shape mirrors the schemas above plus a `papers: Record<handle, Paper>` map.

Components:

- **`StageStepper`** — 5-step horizontal indicator. Each step: pending / spinning / done / failed. Updates on `stage` events.
- **`ProgressLine`** — single-line "what's happening right now" with a spinner. Shows the most recent `progress` event's `label`; if `current`/`total` present, renders a thin progress bar instead.
- **`ScriptPanel`** — collapsible, syntax-highlighted R block. Streams tokens during `write`. Shows a "Validated ✓" or "Rejected ✗ — retrying" banner when `validate` fires.
- **`SectionCard`** — header (title, inferred-mode label, N total/shown, year/category filter chips), optional `query`/`sql` reveal, then a list of `PaperRow`s. Renders incrementally as `section` events arrive. **Collapsed by default** and rendered *below* the synthesis — see `03_interface.md` "Reading order" for the rationale.
- **`PaperRow`** — compact one-liner: rank, title, authors, year, journal, similarity badge. Click expands into `PaperCard`.
- **`PaperCard`** — full record with abstract, BibTeX copy button, "show citations" → calls `/papers/:handle/citations` (a thin proxy to the existing endpoints), small sparkline of `cites_by_year` if `stats` present, versions list.
- **`SynthesisPanel`** — streams markdown; sits *above* the collapsed `SectionCard` list. Inline citation links (`[Author Year](url)`) open in a new tab; bare handle substrings (`` `RePEc:…` ``) auto-linkify to scroll-to and expand the corresponding `PaperCard` below. See §4.8.
- **`BibtexDrawer`** — bottom drawer with the final `.bib` and a "Copy all" button, opened on `bibtex` event.
- **`ErrorToast`** — non-recoverable `error` events.

### 4.7 Example event sequence (abridged)

```
stage  enter clarify
assistant delta "One quick question — do you want to include working papers? …"
stage  exit  clarify  ms=4200
stage  enter write
script delta "# Top-5 + Field-A keyword sweep on bureaucratic quality\nkw1 <- sql_query(\"SELECT Handle, title, year, …"
stage  exit  write    ms=6100
stage  enter validate
validate ok=true
stage  exit  validate ms=80
stage  enter execute
progress "Keyword sweep: 'bureaucratic quality' in Top 5 + Field-A…"
progress "  ↳ 47 results in 0.3s"
paper    {handle: "RePEc:…", title: "…", …}     # first time this handle is seen
paper    {handle: "RePEc:…", …}
section  {id: "kw-1", title: "Bureaucratic quality — keyword sweep", n_total: 47, n_shown: 25, rows: [...]}
progress "Semantic search: 'How the quality of local public administration…'"
progress "  ↳ 15 results in 1.8s"
section  {id: "sem-1", …}
…
bibtex   {entries: 38, bibtex: "@article{…}\n\n@article{…}"}
stage    exit execute  ms=14200
stage    enter synthesize
synthesis delta "## Overview\n\nThe literature on …"
…
stage    exit synthesize ms=11800
done     ms_total=36400
```

### 4.8 In-place rendering on the web

The web synthesis is rendered markdown, not a static blob. `SynthesisPanel` streams tokens into a Markdown→HTML renderer (`react-markdown` + `remark-gfm` for tables). Two link conventions are recognised:

1. **External paper links** — the synthesiser emits inline citations as real markdown links pointing at the paper's `url` (e.g. `[Card & Krueger 1994](https://doi.org/10.1257/aer.84.4.772)` or a publisher/working-paper landing page; IDEAS only as a last-resort fallback). A rehype plugin rewrites all such links to `target="_blank" rel="noopener noreferrer"` so they open in a new tab without breaking the user's place in the review. The model is taught (`04_prompts.md` §5) to use exactly this shape on every citation.
2. **Internal handle anchors** — bare RePEc handle substrings (`RePEc:…`) are auto-linkified by the same rehype plugin to in-page anchors that scroll to the corresponding `PaperCard` in the evidence section below and expand it. These never open new tabs.

The result reads like a published lit-review section: headings, bold, italics, tables, blockquotes all render in place as they stream, and every cited paper is one click from the source on RePEc.

### 4.9 Downloadable artifacts

Once a run completes, four artifacts are generated server-side from the structured output and offered as downloads in a small toolbar below the synthesis. They are **derived deterministically from `search_id`'s structured payload** — rendered lazily on first request, cached on disk, served as static files thereafter.

| Artifact | Format | What it contains |
|---|---|---|
| `report_<slug>.pdf` | PDF | Title (from brief), date, DB snapshot date, brief verbatim, full synthesis prose, per-section paper listings formatted like the lit-search `results.md` pattern, references section, appendix with the R script that produced it |
| `papers_<slug>.xlsx` | Excel workbook | Sheet 1 **Papers** (one row per unique handle: handle, title, authors, year, journal, category, abstract, url, bibtex, max similarity across sections, comma-list of section IDs the paper appeared in). Sheet 2 **Sections** (id, title, mode, query/sql, n_total, n_shown, filters). Sheet 3 **Stats** (handle, cites_total, cites_internal, percentile, top5_citer_share — only for papers where stats were fetched) |
| `references_<slug>.bib` | BibTeX | All `bib_tex` strings for the unique handles in the run, deduped, sorted by year then first author |
| `report_<slug>.md` | Markdown | The raw markdown source (same content as the PDF synthesis + listings), so users can re-render or paste into their own document |

**PDF generation.** Recommended: **Typst** via the `typst` CLI (single static binary, sub-second compile, modern templating syntax, no LaTeX install). A single `templates/report.typ` file consumes the structured JSON via `--input data=…` and renders the full report. Fallback option: pandoc + a small LaTeX class if the team already has TinyTeX on the box (which is likely from the R side); rule that out only if Typst's typography output is not academic-looking enough.

**XLSX generation.** `exceljs` in the Node service — supports formula-free workbooks with frozen headers and column auto-width, which is all we need.

**Endpoints** (web):
- `GET /searches/{id}/report.pdf`
- `GET /searches/{id}/papers.xlsx`
- `GET /searches/{id}/references.bib`
- `GET /searches/{id}/report.md`

All four are also content-addressable by `search_id`, so a saved URL keeps working as long as the search row exists.

**Stream events.** When each artifact finishes rendering, an event is emitted so the toolbar buttons enable progressively:

```ts
| { type: "artifact"; seq: number; kind: "pdf"|"xlsx"|"bib"|"md"; url: string; bytes: number }
```

The MD and BIB artifacts complete in milliseconds (string concat); PDF and XLSX take a second or two — worth showing a spinner on those specific buttons rather than blocking the whole UI.

### 4.10 Why FD 3 rather than parsing stdout

R's `message()`, `warning()`, and any rogue `print()` from a library all land on stderr/stdout. Mixing them with structured events on the same channel means brittle parsing. FD 3 is a clean side-channel: only `emit_event()` writes to it, the runner reads it, everything else from R is discarded (or kept for debug logging only). This is the same pattern the original `emit_result` plan used, generalised to streaming.

---

## 5. Model choice

Concrete model picks and the OpenRouter-caching constraints behind them live in **`02_implementation_plan.md` §2.1**. The summary here:

- All stages are constrained to the OpenRouter caching allowlist (currently `qwen3-coder-flash`, `deepseek-v3.2`, `qwen3-coder-plus`, `claude-haiku-4.5`, Gemini Flash). Models outside the allowlist disqualify themselves because the ~4–5k token cached system prompt is the biggest cost lever and only pays off when the cache actually hits.
- Defaults: a cheap caching-eligible writer/synthesiser (Qwen 3 Coder Flash or DeepSeek v3.2 lead candidates); Haiku 4.5 as quality fallback because of its best-in-class 0.1× cached-read multiplier.
- **Retry policy:** if static check rejects, return the rejection reason to the writer model and let it try once more (see `04_prompts.md` §3). After two failures, fall back to the quality fallback model on the same cached prompt.
- **Prompt-cache discipline:** every model call must log `prompt_tokens_details.cached_tokens`; a model that supports caching on paper but fails to hit through OpenRouter is rejected at benchmark time.

---

## 6. Service shape

The concrete repo layout is owned by **`02_implementation_plan.md` §1–§2**. In short: a top-level `agentic/` folder alongside the existing `backend/` and `frontend/`, containing `agentic_backend/` (TypeScript + Hono, also hosts the MCP server), `agentic_frontend/` (Astro + React), and `r/` (the `eddysearch.sandbox` package + `check.R` AST allowlist + `run.R` entrypoint). Infra (systemd unit + sandbox slice + Caddy reverse proxy for `agenticsearch.eduard-bruell.de`) co-locates on the same box as the existing eddyspapers service; the sandbox slice is the only thing that needs careful systemd hardening (see §3.5).

---

## 7. Coding-agent interface (MCP)

The same agent core that powers the web chat is exposed as an **MCP server** so coding agents (Claude Code, Cursor, …) can spawn searches mid-flow without leaving the terminal. This replaces the current MCP server in `backend/R/mcp_server.R` + `run_mcp_server*.R`, which only wrapped individual REST endpoints one-to-one.

The point of replacing it: today the coding agent has to chain `search_papers` → look at JSON → call `get_versions` → call `get_citations` → write the synthesis itself, burning its own context on raw result blobs. With agentic-search-as-MCP, it makes **one** call with a brief and gets back a finished mini-lit-review plus structured data — the heavy lifting (script writing, R execution, synthesis) happens in our cheap sub-model, not in the calling agent's context.

### 7.1 Architecture — one core, two faces

```
                ┌── SSE → agenticsearch.eduard-bruell.de  (web chat)
agent core ────┤
                └── MCP (stdio + streamable HTTP) →  coding agents
```

The MCP server is a thin transport adapter in the same Node service, importing `packages/agent/runAgent.ts`. Both faces emit the same stream of typed events (§4.3); the MCP adapter rewrites them as MCP progress notifications and a final `CallToolResult`. No duplicated business logic.

Transports: **stdio** for local launches (a coding agent spawns the binary) and **streamable HTTP** for the hosted variant at `agenticsearch.eduard-bruell.de/mcp` (one URL, bearer-token auth). The streamable-HTTP path is the right default — same TLS endpoint as the web UI, no per-machine install required.

### 7.2 Tool surface — two doors, not seven

Reading the current `mcp_server.R`, the surface is per-endpoint (`search_papers`, `get_versions`, …). We collapse that to **two intents**:

**`lit_search`** — the full agentic pipeline. Use when the calling agent wants a synthesis, not raw rows.
```jsonc
{
  "brief":        "string  // natural-language description of what to find",
  "modes":        "string[]?  // subset of: topic, journal_scan, active_authors, recent_wp, editor_targeting",
  "must_include": "string[]?  // authors or handles that MUST appear if present in the DB",
  "year_range":   "[number, number]?",
  "categories":   "string[]?  // override the default category mix",
  "max_sections": "number?  // default 5",
  "format":       "'markdown' | 'json' | 'both'  // default 'both'",
  "skip_clarify": "boolean  // default TRUE for MCP (the calling agent already filtered)"
}
```
Returns: synthesis markdown + bibtex + structured `sections[]`/`papers[]` (schemas from §4.4) + a resource URI for follow-up reads.

**`find_papers`** — direct, no LLM, no sandbox. Wraps the existing `/search` endpoint with the same parameters as today's `search_papers` tool. Cheap, fast, used when the caller just wants "Smith 2020 on minimum wage" or a quick top-K. Kept because not every coding-agent question needs the fat pipeline — and routing trivial lookups through the agent would waste tokens and time.

That's it. Versions, citations, stats are reachable via **resources** (§7.5), not tools — coding agents don't need eight separate tool buttons for what is conceptually "look up more about this paper."

### 7.3 Skip-clarify by default

The web UI happily asks one clarifying question. A coding agent does not want a blocking question mid-tool-call — its own model already shaped the brief. So:

- `skip_clarify = true` (the MCP default): the clarifier stage is replaced by a single internal pass that *infers* sensible defaults (modes, year range, categories) from the brief and proceeds. If the brief is genuinely ambiguous, the tool returns a `CallToolResult` with `isError: false` and a `needs_clarification` structured field listing the questions, so the calling agent can re-invoke with more detail. **No blocking prompts** over MCP — ever.
- `skip_clarify = false`: returns the clarification questions and stops; the agent makes a second call passing answers in the brief. Useful when the human is in the loop in the calling agent.

### 7.4 Streaming via progress notifications

MCP supports `notifications/progress` against a `progressToken` on the call. We re-emit our internal events as progress notifications so the coding agent sees a live status line ("Semantic search: '…' → 15 results in 1.8s") rather than a 30-second silent wait.

Mapping:

| Internal event       | MCP notification                                                |
|----------------------|-----------------------------------------------------------------|
| `stage enter/exit`   | `progress` with `progress` 1/5..5/5 and `message`               |
| `progress`           | `progress` with `message` (no numeric advance)                  |
| `validate ok=false`  | `progress` with `message: "Script rejected — retrying"`         |
| `section`            | `progress` with `message: "Section ready: <title> (N papers)"`  |
| `synthesis delta`    | not forwarded (would flood); synthesis is delivered whole at the end |
| `error`              | `CallToolResult { isError: true, content: [...] }`              |
| `done`               | terminal — return final `CallToolResult`                        |

The caller doesn't need to know our internal event taxonomy — they see prose progress lines that read naturally in a terminal.

### 7.5 Output shape

Coding agents don't want a PDF — they want text they can drop into the project and a flat table they can grep, join, or feed to follow-up tool calls. The MCP result is therefore a **three-artifact bundle** (report MD, BibTeX, CSV) plus the structured payload.

The CSV is deliberately *not* the Excel workbook: one flat table is what `awk`, `csvkit`, `dplyr::read_csv`, and a coding agent's own pattern matching all handle naturally.

`CallToolResult` for `lit_search`:

```jsonc
{
  "content": [
    { "type": "text", "text": "## Literature Synthesis: …\n\n…" }
  ],
  "structuredContent": {
    "synthesis_md":   "string",        // the full report markdown, ready to write to a file
    "bibtex":         "string",        // entire .bib, deduped, sorted by year/author
    "papers_csv":     "string",        // see columns below
    "papers":         { /* { [handle]: Paper } — same data as CSV but structured */ },
    "sections":       [ /* Section[] from §4.4 */ ],
    "search_id":      "string",        // hash-keyed; identical brief returns same id
    "script":         "string",        // the R script that produced this run
    "resource_uri":   "agenticsearch://searches/{search_id}",
    "suggested_paths": {                // hints, calling agent decides whether to honour
      "report": "local_context/notes/literature/lit_<slug>.md",
      "bibtex": "local_context/search_related/results_<slug>.bib",
      "csv":    "local_context/search_related/results_<slug>.csv"
    }
  }
}
```

**CSV columns** (`papers_csv`):

| Column | Description |
|---|---|
| `handle` | RePEc handle, primary key |
| `title` | |
| `authors` | comma-joined string as stored in DB |
| `year` | |
| `journal` | |
| `category` | journal category from the ZEW ranking |
| `url` | link to RePEc page if present |
| `abstract` | full abstract (may be empty) |
| `max_similarity` | best (lowest) cosine distance across sections it appeared in; empty if it only came from a keyword/SQL section |
| `sections` | pipe-joined section IDs where the paper appeared (`kw-1|sem-2`) |
| `cites_internal` | populated only if the run fetched `handle_stats` for this paper |
| `cites_total` | same |
| `percentile` | same |

Pipe-separator on `sections` (and any other multi-valued column) keeps the file safe to parse with naive `,` splitting.

The calling agent's typical use: write `synthesis_md` to `suggested_paths.report`, write `bibtex` to `suggested_paths.bibtex`, write `papers_csv` to `suggested_paths.csv`, then point its own context at the CSV for follow-up queries ("which of these are from 2020+?") rather than re-loading the full `papers` JSON.

`find_papers` returns a simpler structure — just `papers: Paper[]` and a CSV string with the same columns above (minus `max_similarity`/`sections` since there's only one search).

### 7.6 Resources

A completed search registers a set of MCP resources the caller can read later (within the session or via the persistent URI):

- `agenticsearch://searches/{id}` — overview (brief + synthesis + sections summary)
- `agenticsearch://searches/{id}/script` — the R script
- `agenticsearch://searches/{id}/bibtex` — `.bib` text
- `agenticsearch://searches/{id}/papers` — full paper records as JSON
- `agenticsearch://searches/{id}/sections/{section_id}` — one section's full row set
- `agenticsearch://papers/{handle}` — canonical paper record (resolves via existing `/handlestats`, `/versions`, `/citedby`)
- `agenticsearch://papers/{handle}/citedby?limit=N` — papers citing this one
- `agenticsearch://papers/{handle}/cites?limit=N` — references of this one

Resources are listable so the calling agent can discover what's available without guessing URIs. The paper-level resources subsume the role of the old `get_versions`, `get_citations`, `get_handle_stats` tools without forcing them into the top-level tool list.

### 7.7 Prompts (MCP prompt templates)

Three named prompts ship with the server so coding agents can invoke common intents without having to phrase the brief themselves:

- `lit_review` — args: `topic`, `purpose` (paper/grant/cover-letter) → expands into a well-shaped `lit_search` brief.
- `find_referees` — args: `topic`, `journal` → uses editor-targeting mode.
- `journal_scan` — args: `journal`, `keywords[]` → exhaustive single-journal sweep.

These help small calling models stay on-pattern without re-deriving the lit-search heuristics.

### 7.8 Caching and dedup

`search_id` is a stable hash over `{brief, modes, year_range, categories, must_include, db_snapshot_date}`. Identical briefs against the same snapshot return the cached result without re-running R or the synthesiser. This matters because coding agents retry tool calls more than humans do, and because the same brief recurring across sessions (e.g. each time someone reopens a paper) should be free.

Cache TTL: until the next snapshot rotation (nightly). Stored as one row in a `searches` DuckDB table (separate from `articles` snapshot — read-write, but tiny).

### 7.9 Auth and limits

Bearer-token auth (`Authorization: Bearer <key>`) on the streamable-HTTP transport, same key issuance flow as the existing API key. Per-key:

- `lit_search`: 30 / hour, 300 / day (each call costs real model tokens + ~30 s sandbox time).
- `find_papers`: 600 / hour (cheap, no model).
- Single concurrent `lit_search` per key (queue the second).

Stdio transport (local) bypasses auth — the key is "you have shell on this machine."

### 7.10 Migration from the current R MCP server

1. Build the new Node MCP adapter against `runAgent.ts`; ship `find_papers` first since it's pure passthrough.
2. Add `lit_search` once the agent core is working end-to-end via the web path.
3. Update the deployed MCP config (Claude Code `.mcp.json`, etc.) to point at the new endpoint.
4. Keep `backend/R/mcp_server.R` and `run_mcp_server*.R` running on the old port for one week as a fallback; then delete.
5. The R MCP files have no logic worth preserving — they're thin `httr2` wrappers around `/search` and friends. Deletion only.

---

## 8. Failure modes worth thinking about up front

- **Model writes a script that returns 50k rows.** Mitigation: auto-injected `LIMIT 5000` on raw SQL; `emit_section` truncates per-section; final JSON capped at 2 MB.
- **Model writes a runaway join or LIKE on every column.** Mitigation: DuckDB `statement_timeout = 15s` + 30s wall-clock kill.
- **Model bypasses the curated API via clever R.** Mitigation: AST allowlist rejects every unlisted symbol — `eval`, `parse`, `do.call` with non-literal, `get`, `::` (except `magrittr`), `:::`. Process sandbox catches what the AST misses.
- **Model crafts SQL that escapes the read-only intent.** Mitigation: DuckDB parse-tree validation rejects anything outside `SELECT` / set ops; `disabled_filesystems` + `enable_external_access = false` + `lock_configuration = true` prevent `ATTACH`, `COPY TO`, `read_csv('https://…')` even if validation has a gap.
- **Static check too strict, model can't land a valid script.** Mitigation: every rejection is logged with the offending node + reason; we feed rejection reason back to the writer model for one retry; rejections become a dataset for prompt and allowlist iteration.
- **DB schema changes break generated scripts.** Mitigation: curated verbs hide schema. For raw SQL, the schema reference in the system prompt is the single source of truth — update it when schema changes.
- **Concurrent requests exhaust the box.** Mitigation: bounded job queue in the API; sandbox slice caps total memory; consider a small pool of long-lived R workers (callr) to amortise startup if cold-Rscript latency hurts.
- **Abuse (scripted scraping of the corpus).** Mitigation: per-IP rate limit, optional auth, output size cap effectively blocks bulk export, snapshot DB means worst case is "yesterday's data."
- **Model writes a custom `for` loop that allocates a 10 GB vector.** Mitigation: `MemoryMax=1G` kills it; `print`/`message` discarded so the loop has no exfil channel anyway.

---

## 9. Open questions

1. **Direct DuckDB access vs. Plumber-only.** Direct is faster and lets `PrivateNetwork=yes` actually work, but couples the sandbox package to the DB file layout. Recommendation: direct, with the curated package as the only consumer.
2. **DB snapshot cadence.** A nightly read-only snapshot is safer than sharing the live file with the syncer (which writes). Worth the disk.
3. **Streaming script execution output.** Probably not — wait for the JSON blob, stream only the synthesiser's tokens. Simpler and avoids leaking intermediate state.
4. **Saving searches.** Reuse the existing `/search/save` hash mechanism, or make agentic conversations first-class with their own table? Probably the latter — they're structurally different.
5. **Citation-aware iteration.** Should the writer be allowed to emit a *sequence* of scripts (search → pick top handles → expand via `citedby` → re-rank)? Yes, but cap at 3 script rounds total.

---

## 10. First milestones

1. Stand up `eddysearch.sandbox` R package with `semantic_search` + `sql_query` + the `emit_*` family; FD-3 event writer; confirm read-only DuckDB path and DuckDB hardening pragmas.
2. Write `check.R` AST allowlist; unit-test against a corpus of "obviously bad" scripts and a corpus of real lit-search scripts (must accept all of them).
3. Wrap both in a TS function `runSandbox(script: string, onEvent: (e) => void): Promise<Result>`; benchmark cold-start (Rscript boot is the main cost — consider a long-lived R worker pool via callr if it's painful).
4. Wire Haiku 4.5 script-writer with cached few-shots; eyeball 20 sample queries end-to-end (no UI yet — just inspect the event log) before touching the frontend.
5. Build the Astro chat UI against a recorded event log so frontend work doesn't need a live backend; then connect to live SSE.
6. Add the MCP adapter — `find_papers` first (pure passthrough, validates the transport), then `lit_search` reusing the same `runAgent` core; switch coding-agent configs over; retire `backend/R/mcp_server.R` after a week of dual-running.
