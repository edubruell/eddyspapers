# Agentic Search — Overview & Reading Order

**Target product:** `agenticsearch.eduard-bruell.de` — a hosted, multi-turn web/MCP service that turns a natural-language brief into a structured literature review, drawing on the same RePEc-backed DuckDB that powers [Eddy's Papers Semantic Search](https://eddyspapers.eduard-bruell.de).

This folder contains the design corpus. Read in this order:

| # | Doc | What it owns |
|---|---|---|
| 00 | **this file** | high-level direction, what we're building and why, doc map |
| 01 | [`01_design.md`](./01_design.md) | system architecture: pipeline, the defused-R sandbox, streaming/SSE protocol, structured wire schemas, MCP server, failure modes |
| 02 | [`02_implementation_plan.md`](./02_implementation_plan.md) | concrete repo layout, language choices (TS/Hono, Astro/React, R `eddysearch.sandbox`), module boundaries, model-selection budget, milestone order |
| 03 | [`03_interface.md`](./03_interface.md) | visual + UX design: palette, primitives shared with the existing app, two-phase layout, reading order, microcopy, mobile, branding |
| 04 | [`04_prompts.md`](./04_prompts.md) | **context engineering** — how every stage's prompt is assembled, what stays in the cache, what gets injected per-run, lit-search-skill replication in a hosted setting |
| 05 | [`05_roadmap.md`](./05_roadmap.md) | **plan of attack** — phased build order with concrete tasks, acceptance criteria per phase, dependency graph, cross-cutting risks |
| — | [`reference_lit_search_skill.md`](./reference_lit_search_skill.md) | **reference snapshot** of the `lit-search` Claude Code skill that the agentic project is modelled on. Verbatim copy of `~/.claude/skills/lit-search/SKILL.md` — read alongside `04_prompts.md` to see what the hosted agent reproduces |

The four documents are **canonical** — when they conflict, the lower-numbered one wins for system decisions, the higher-numbered one wins for surface decisions (a UI tweak in 03 supersedes a UI mention in 01).

---

## 1. The one-paragraph version

The `lit-search` Claude Code skill already works: the model reads project context, asks a clarifying question, writes a tailored R script against the local DuckDB, runs it, then synthesises a literature review with a companion `.bib`. We're productising that exact loop as a hosted service — same shape, **fewer assumptions** (no local filesystem, no Claude Code, no `local_context/` to read) — and exposing it twice: once as a streaming web UI (`agentic_frontend/`) and once as an MCP server other coding agents can call (`lit_search` tool). The heavy lifting (script writing, R execution against a hardened sandbox, synthesis) happens in a **cheap sub-model**, not in the caller's context.

## 2. Why R-scripts-in-a-sandbox, not tool-calling

A tool-calling agent that exposes `semantic_search`, `cites`, `citedby`, `handle_stats`, `versions`, etc. would need a dozen brittle endpoints to match what the existing `lit-search` skill does in 30 lines of R (keyword chains, `LIKE '%…%'` over multiple columns, dedup-by-version, per-section ranking heuristics, custom percentile cuts, mixed semantic + SQL sweeps). One scripted query against a local DuckDB is also cheap and fast; an iterative tool loop racks up tokens and round-trips. So we keep the script-writing pattern and pay the price as a **hardened R sandbox** (`01_design.md` §3).

## 3. What's shared with what

```
                 ┌── SSE → agenticsearch.eduard-bruell.de  (web chat)
   runAgent() ──┤
                 └── MCP (stdio + streamable HTTP) → coding agents
                          (one tool: lit_search; one passthrough: find_papers)
```

Both faces consume the **same `StreamEvent` schema** and the same structured `Section`/`Paper` payloads. Web SSE renders them progressively; MCP translates them into progress notifications and a final bundled `CallToolResult`. No duplicated pipeline logic. (`01_design.md` §7, `02_implementation_plan.md` §2.2.)

The web app shares its **visual primitives** (Card, Pill, PrimaryButton, GhostButton, SimilarityBar, AdvancedDisclosure, DatabaseFooter, SectionLabel) verbatim with the existing `frontend/`; the only structurally new primitive is the 5-step `StageStepper`. (`03_interface.md` §1.3.)

The two apps differ only in **logo (detective meerkat)**, **wordmark (`AGENTIC SEARCH`)**, and a small **accent-colour shift** on the primary button — small enough to read as siblings, distinct enough to recognise side-by-side. (`03_interface.md` §2.)

## 4. Hard design choices already made

- **Stack:** TypeScript on Node (Hono) for the orchestrator and MCP server; Astro + React for the web UI; R for the sandbox subprocess. Vercel AI SDK + OpenRouter for model calls.
- **DB access:** the sandbox reads a **read-only copy of the most recent updated DuckDB**, repointed by the existing `update_repec.R` pipeline (which runs weekly/monthly, not nightly). Live file can be read directly when no update is in flight; the copy exists only to avoid races. Everything else (paper lookups outside a script) goes through the existing Plumber REST API — but this is a fallback, since the script can already query the DB directly.
- **Model selection is constrained by OpenRouter's caching allowlist.** The ~4–5k token cached system prompt is the biggest cost lever and only pays off on supported models — currently `qwen3-coder-flash`, `deepseek-v3.2`, `qwen3-coder-plus`, `claude-haiku-4.5`, Gemini Flash. Cheap defaults come from this list (Qwen 3 Coder Flash or DeepSeek v3.2 as lead candidates) with Haiku 4.5 (0.1× cached-read multiplier) as quality fallback. Per-query cost + verified cache-hit ratio benchmarked on ~50 representative briefs before committing — see `02_implementation_plan.md` §2.1.
- **No file writes from the sandbox.** R user scripts emit events through FD 3 via `emit_section`/`emit_note`/`emit_bibtex` — the orchestrator buffers, serialises, and turns them into wire events. Removes "where can scripts write?" from the threat model.
- **Defence in depth on the R side:** curated `eddysearch.sandbox` package providing the only allowed verbs + AST allowlist on the generated script + systemd-level process sandbox + DuckDB hardening pragmas. (`01_design.md` §3.)

## 5. Three things we're explicitly **not** building in v1

- Iterative multi-script runs (search → expand via citations → re-search). One script per run; cap at three retries on validation failure with feedback to the writer. (`01_design.md` §9.5 — left open but deferred.)
- Paper upload as brief context. Tempting, but doubles per-query cost; revisit once the cost picture stabilises. (`03_interface.md` §7.1.)
- Mode pills as a UI primitive. The brief writer infers modes from prose; modes only show up as a small label inside the (collapsed) `SectionCard` header.

## 6. Milestone arc

The full phased plan with concrete tasks, acceptance criteria, and dependency graph lives in **[`05_roadmap.md`](./05_roadmap.md)**. Twelve phases at a glance:

| # | Phase | Gate |
|---|---|---|
| 0 | Project scaffolding | repo tree boots |
| 1 | R sandbox foundation (`eddysearch.sandbox`) | ⚠ blocks 2–4 |
| 2 | AST allowlist (`check.R`) | ⚠ blocks 5 |
| 3 | TS sandbox runner | ⚠ blocks 5 |
| 4 | LLM layer + writer stage | 20-brief eyeball |
| 5 | **Cost benchmark + model lock-in** | 🟥 Eddy sign-off gate |
| 6 | `runAgent` + SSE transport | full pipeline live |
| 7 | Web frontend | sibling-app feel |
| 8 | Downloadable artifacts (PDF/XLSX/BIB/MD) | all four download |
| 9 | MCP adapter | Claude Code uses `lit_search` |
| 10 | Auth, rate limits, deploy | public URL on TLS |
| 11 | Retire old R MCP server | one-week dual-run |
| 12 | Polish & post-launch (continuous) | history, share, DOI, etc. |

Phase 5 is the cost gate — nothing downstream commits until model picks and per-query cost are signed off. Phases 7 and 9 can run in parallel once Phase 6 exposes `runAgent`.

---

## 7. Glossary

| Term | Meaning |
|---|---|
| **brief / task** | The user's natural-language description of what to find. UI label is `TASK`. |
| **section** | One block of results inside a single run (e.g. "keyword sweep over Top 5 + Field-A"). |
| **mode** | The kind of section: `keyword`, `semantic`, `journal_scan`, `author`, `wp`, `editor`, `custom`. Inferred from the script, not set by the user. |
| **handle** | A RePEc paper identifier — primary key across the whole system. |
| **search_id** | Stable hash over `{brief, modes, filters, db_snapshot_date}`. Used for caching, permalinks, and share URLs. |
| **synthesis** | The streamed-markdown literature review the synthesiser model produces from the sections. The primary deliverable. |
| **artifact** | Downloadable derivative of a completed run: PDF, XLSX, `.bib`, `.md`. Rendered lazily, cached on disk. |
