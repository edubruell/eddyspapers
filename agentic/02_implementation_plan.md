# Agentic Search — Implementation Plan (Note 2)

**Companion to:** `agentic_search_design.md`
**Scope:** concrete repo layout, language choices, and module boundaries for building the agentic search app alongside (not inside) the existing `backend/` and `frontend/`.

This note pins down decisions that the design doc left as "stack" stubs:

- The agentic app lives in a top-level `agentic/` folder. `backend/` and `frontend/` are **not** touched.
- `agentic_backend/` is **TypeScript on Node**, served via **Hono**.
- LLM work goes through **Vercel AI SDK** (`ai`) + **`@openrouter/ai-sdk-provider`** — one provider abstraction, swap models per-stage via config, native streaming, structured output via `generateObject`, Anthropic prompt-caching headers pass through.
- `agentic_frontend/` is **Astro + React**, mirroring the conventions in the existing `frontend/` but as a completely separate app.
- The only direct DB access is the sandbox subprocess, reading a **read-only copy of the most recent updated DuckDB** (re-pointed by `update_repec.R`, which runs weekly/monthly — not nightly). The existing backend REST API is a thin fallback for the rare paper lookup that happens *outside* a script run (see §3).

---

## 1. Top-level layout

```
eddyspaperui/
├── backend/                 # unchanged (eddyspapersbackend R package + Plumber API)
├── frontend/                # unchanged (current Astro search UI)
└── agentic/
    ├── agentic_backend/     # TS / Hono orchestrator + sandbox runner + MCP server
    ├── agentic_frontend/    # Astro + React chat UI
    └── r/                   # eddysearch.sandbox R package + check.R + run.R
```

`agentic/r/` lives under `agentic/` because it is consumed only by the sandbox runner. It depends on `eddyspapersbackend` as a library (path-based remote or `devtools::install_local`) but is otherwise independent.

`agentic/` is self-contained: cloning only `agentic/` plus the snapshot DB plus the backend REST URL is enough to run it.

---

## 2. `agentic_backend/` — TypeScript layout

```
agentic_backend/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Hono app entry, mounts routes, starts server
│   ├── env.ts                    # zod-validated env (OPENROUTER_API_KEY, DB_SNAPSHOT, BACKEND_URL, …)
│   │
│   ├── routes/
│   │   ├── chat.ts               # POST /chat  → kicks off run, returns {id}
│   │   ├── stream.ts             # GET  /chat/:id/stream  (SSE)
│   │   ├── searches.ts           # GET  /searches/:id, /report.pdf, /papers.xlsx, /references.bib, /report.md
│   │   ├── papers.ts             # GET  /papers/:handle/citations  (thin proxy to backend REST)
│   │   └── mcp.ts                # MCP streamable-HTTP transport mount (/mcp)
│   │
│   ├── agent/                    # the pipeline — one core, used by web + MCP
│   │   ├── runAgent.ts           # orchestrates clarify → write → validate → execute → synthesize
│   │   ├── stages/
│   │   │   ├── clarify.ts
│   │   │   ├── writeScript.ts
│   │   │   ├── validate.ts       # calls sandbox check.R, returns {ok, reason}
│   │   │   ├── execute.ts        # spawns run-sandbox.sh, parses FD-3 events
│   │   │   └── synthesize.ts     # streamed markdown synthesis
│   │   ├── models.ts             # per-stage model config + fallbacks
│   │   └── cache.ts              # search_id hashing + result memoisation (DuckDB-backed)
│   │
│   ├── llm/                      # provider abstraction (thin — AI SDK does the heavy lifting)
│   │   ├── client.ts             # createOpenRouter({ apiKey }) → shared provider instance
│   │   ├── stream.ts             # streamText helpers w/ prompt caching headers
│   │   └── structured.ts         # generateObject wrappers for clarify-questions, etc.
│   │
│   ├── sandbox/
│   │   ├── runSandbox.ts         # spawn Rscript via systemd-run, wire FD3 → onEvent
│   │   ├── checkScript.ts        # spawn check.R, parse {ok, reason, offending_node}
│   │   ├── events.ts             # FD-3 JSON-line parser → StreamEvent[]
│   │   └── snapshot.ts           # snapshot path resolution + freshness check
│   │
│   ├── mcp/
│   │   ├── server.ts             # @modelcontextprotocol/sdk Server bootstrap
│   │   ├── tools/
│   │   │   ├── litSearch.ts      # wraps runAgent, maps StreamEvent → progress notifications
│   │   │   └── findPapers.ts     # direct passthrough to backend /search
│   │   ├── resources.ts          # agenticsearch://searches/* + papers/* resolvers
│   │   └── prompts.ts            # lit_review, find_referees, journal_scan templates
│   │
│   ├── artifacts/                # lazy, cached, content-addressed by search_id
│   │   ├── pdf.ts                # Typst CLI invocation, templates/report.typ
│   │   ├── xlsx.ts               # exceljs workbook builder
│   │   ├── bib.ts                # string concat
│   │   └── md.ts                 # string concat
│   │
│   ├── stream/
│   │   ├── sse.ts                # Hono SSE helper, seq counter, heartbeat
│   │   └── bus.ts                # in-memory pub/sub per search_id (web SSE + MCP both subscribe)
│   │
│   ├── db/
│   │   ├── searches.ts           # tiny read-write DuckDB for {searches} cache table
│   │   └── backend.ts            # read client for the prod articles DB via existing REST API
│   │
│   └── prompts/                  # cached system prompts + few-shots as TS consts
│       ├── apiReference.ts       # eddysearch.sandbox API ref (cached, ~3–5k tokens)
│       ├── examples.ts           # worked example scripts
│       ├── clarify.ts
│       └── synthesize.ts
│
├── schemas/                      # shared with agentic_frontend (workspace pkg or path import)
│   ├── events.ts                 # StreamEvent union (design §4.3)
│   ├── section.ts                # Section, SectionRow (§4.4)
│   ├── paper.ts                  # Paper (§4.4)
│   └── mcp.ts                    # lit_search input/output shapes
│
├── templates/
│   └── report.typ                # Typst template for PDF reports
│
├── bin/
│   ├── run-sandbox.sh            # systemd-run --scope --uid=eddysandbox … Rscript run.R
│   └── check.sh                  # Rscript check.R
│
└── tests/
    ├── ast/                      # corpus of good/bad scripts
    ├── sandbox/                  # end-to-end Rscript exec tests
    └── agent/                    # runAgent with mocked LLM
```

### 2.1 LLM layer — OpenRouter via Vercel AI SDK

`llm/client.ts` is ~10 lines:

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { env } from "../env";
export const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
```

Stages pick models from `agent/models.ts`:

```ts
// Concrete model IDs are deferred — see "Model selection & cost budgeting" below.
// Placeholder shape:
export const models = {
  clarify:     openrouter(env.MODEL_CLARIFY),
  writer:      openrouter(env.MODEL_WRITER),
  writerRetry: openrouter(env.MODEL_WRITER_RETRY),
  synthesise:  openrouter(env.MODEL_SYNTH),
  altWriter:   openrouter(env.MODEL_ALT_WRITER),
  altSynth:    openrouter(env.MODEL_ALT_SYNTH),
};
```

**Model selection & cost budgeting (open).** Default candidates are constrained by **what OpenRouter actually caches**, because the writer's ~4–5k token system prompt (API reference + few-shots + journal categories) is the biggest cost lever and only pays off when cached reads hit. OpenRouter does **not** run its own cache layer — it passes provider-native caching through, but only for an allowlist of models.

**Caching-eligible candidates** (verified against OpenRouter docs, May 2026):

| Slug | Cached read | Cache mechanism | Role |
|---|---|---|---|
| `qwen/qwen3-coder-flash` | ~0.25× | explicit `cache_control` | primary writer |
| `deepseek/deepseek-v3.2` | ~0.25× | explicit `cache_control` | alt writer / synth |
| `qwen/qwen3-coder-plus` | ~0.25× | explicit `cache_control` | quality writer fallback |
| `anthropic/claude-haiku-4.5` | **0.1×** | explicit `cache_control` | quality fallback for both stages — best cached-read ratio |
| `google/gemini-flash-*` | implicit | no flag needed | alt synth |

Models *not* on this list (most other DeepSeek/Qwen variants) pay full price on the system prompt every call, which roughly doubles per-query cost and disqualifies them as defaults. **"DeepSeek V4 Flash" is not a current OR slug** — the closest caching-eligible DeepSeek is `deepseek-v3.2`; confirm the exact slug before locking pricing.

**Caching gotchas baked into the plan:**

- Enabling `cache_control` triggers **provider sticky routing** on OpenRouter, which weakens the automatic fallback. The fallback chain in `agent/models.ts` must therefore be explicit (try writer → on N consecutive failures, switch to `writerRetry`), not relying on OR's transparent retry.
- There are open issues against `@openrouter/ai-sdk-provider` about flaky cache-hit reporting. **The pipeline must log `prompt_tokens_details.cached_tokens` from usage telemetry on every call during development** — a model that "supports caching on paper" but doesn't actually hit through OR is the worst case. Cache hits are verified, not assumed.
- Cache TTL is 5 min on Qwen/DeepSeek (Alibaba pricing) and Anthropic-default; only Anthropic exposes a `ttl: "1h"` opt-in. The writer/synth stages must stay warm via traffic, not infrastructure.
- Streaming + caching work together — no constraint there.

**Vercel AI SDK shape** for the cached system block:

```ts
{
  role: "system",
  content: [{
    type: "text",
    text: cachedSystemPrompt,
    providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } }
  }]
}
```

**Benchmark before committing.** ~50 representative briefs from Eddy's lit-search history get replayed against each caching-eligible candidate, measuring (a) script-validity rate after one retry, (b) synthesis quality vs. Haiku baseline, (c) wall-clock, (d) per-query cost in USD, and (e) **verified cache-hit ratio** (cached_tokens / total prompt tokens) on stages 2–N of the same brief. A model with strong base economics but unreliable cache hits is rejected. Final picks settle with Eddy before the MCP transport ships.

AI SDK gives streaming (`streamText`) and structured output (`generateObject` with a zod schema) for free; the writer stage uses `generateObject` against a tiny `{ script: string }` schema so we never have to parse code fences out of free-form text. Anthropic `cache_control` headers pass through OpenRouter so the cached API-reference prompt still earns the discount.

### 2.2 One core, two faces

`agent/runAgent.ts` exposes `runAgent({ brief, onEvent })` and emits `StreamEvent`s.

- `routes/stream.ts` subscribes via `stream/bus.ts` and pipes to SSE.
- `mcp/tools/litSearch.ts` subscribes to the same bus and translates events to MCP progress notifications.

Zero duplicated pipeline logic — exactly the "one core, two faces" picture in design §7.1.

### 2.3 Shared schemas

`agentic_backend/schemas/` is the source of truth for every wire shape. `agentic_frontend` imports the same files (either as a workspace package via pnpm, or via a `tsconfig` path alias if we stay single-package). One field change → both sides break at compile time. This is the main reason TS won over Python.
---

## 3. DuckDB access — path (2) only

**One direct DB consumer:** the sandbox subprocess, against a **read-only copy of the most recent updated DuckDB** at a fixed path (e.g. `/var/lib/eddysearch/snapshot.duckdb`). Because the production sync runs **weekly or monthly** (not nightly), the "snapshot" is simply the last good post-update copy — re-pointed by the update pipeline at the end of `update_repec.R`. No cron-driven nightly job. In a pinch the sandbox can read the live DB file directly (also read-only); the copy exists only to avoid the rare race when an update is mid-flight. All hardening pragmas from design §3.4 are applied on connection open inside the `eddysearch.sandbox` R package.

**The REST backend is a fallback, not the primary path.** The agentic pipeline produces R scripts that already do everything the API exposes — `semantic_search`, paper lookups, citation joins, version resolution — directly against the DB. So `db/backend.ts` exists, but it is only used in narrow cases:

- `mcp/tools/findPapers.ts` — the non-agentic direct lookup tool (deliberately not script-driven; just proxies `POST /search`).
- Edge cases where the synthesiser needs *one extra* paper record (e.g. a handle mentioned in a citation list that wasn't in any result set). Even here, prefer extending the sandbox call rather than reaching out.

Endpoints reachable through this client if needed: `POST /search`, `GET /handlestats`, `GET /versions`, `GET /cites`, `GET /citedby`. The MCP `agenticsearch://papers/{handle}/…` resources resolve through this client because they are *outside* a script run.

- The `searches` cache table lives in its own tiny read-write DuckDB owned by `agentic_backend/` (`data/agentic/searches.duckdb`). No mixing of read-write state with the snapshot.



---

## 4. `agentic_frontend/` — Astro + React layout

**The full visual and component design is owned by [`03_interface.md`](./03_interface.md)** — including the inherited palette, the primitives shared with `frontend/`, the two-phase landing↔sidebar layout, the stepper, the synthesis/sections ordering, microcopy, mobile behaviour, and the detective-meerkat branding. This section keeps only what's needed to wire the app up.

```
agentic_frontend/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── public/
└── src/
    ├── pages/
    │   ├── index.astro              # landing
    │   └── c/[id].astro             # one chat session, mounts <SearchChat/>
    │
    ├── layouts/
    │   └── AppLayout.astro
    │
    ├── components/                  # split per 03_interface §11
    │   ├── primitives/              # Card, Pill, PrimaryButton, GhostButton, SectionLabel,
    │   │                            # SimilarityBar, AdvancedDisclosure, DatabaseFooter
    │   ├── chat/                    # SearchChat, Sidebar, BriefPanel, CategoryPills,
    │   │                            # AdvancedFilters, StageStepper, ProgressLine,
    │   │                            # ScriptPanel ("Show database search script"),
    │   │                            # ClarifierBubble (inline), SectionCard, PaperRow,
    │   │                            # PaperCard, SynthesisPanel, BibtexDrawer,
    │   │                            # ArtifactsToolbar, ErrorToast
    │   └── logo/                    # LogoAgentic
    │
    ├── lib/
    │   ├── api.js                   # POST /chat, GET /searches/:id, artifact URLs
    │   ├── stream.ts                # EventSource wrapper → typed StreamEvent emitter
    │   ├── store.ts                 # reducer-backed store (sections, papers map, stage, progress)
    │   └── markdown.tsx             # remark/rehype + RePEc-handle linkify
    │
    ├── schemas/                     # path-aliased to ../../agentic_backend/schemas
    │   └── index.ts
    │
    └── styles/
        └── global.css               # CSS variables mirrored from frontend/ (see 03 §1.1)
```

### 4.1 State model

`lib/store.ts` mirrors the design §4 schemas plus a `papers: Record<handle, Paper>` map. The reducer handles every `StreamEvent` variant exhaustively (TypeScript discriminated unions make this a `never`-checked switch). The store is `useSyncExternalStore`-backed so any island that needs current state can read it without prop drilling.

### 4.2 Streaming consumption

`lib/stream.ts` wraps `EventSource`, reconnects with `Last-Event-ID` on drop, validates each payload with zod against the shared schemas, and emits typed events to the store. The `seq` field detects gaps; on a gap the client requests a replay (`GET /chat/:id/stream?since=<seq>` — orchestrator keeps the last N events in `stream/bus.ts`'s ring buffer).

### 4.3 Shared schemas wiring

`tsconfig.json` path alias:

```jsonc
{
  "compilerOptions": {
    "paths": {
      "@schemas/*": ["../agentic_backend/schemas/*"]
    }
  }
}
```

(Or promote `schemas/` to a workspace package `@agentic/schemas` if we adopt pnpm workspaces; either works.)

### 4.4 Two pages, one island per page

Astro stays mostly static — `index.astro` is a thin landing; `c/[id].astro` is a single `<SearchChat client:load />` mount. Everything dynamic lives in that one React island. This matches the convention in the existing `frontend/`.

### 4.5 Downloadable artifacts

`ArtifactsToolbar.jsx` listens for `artifact` events and enables each button as its URL arrives. The buttons are plain anchor tags pointing at `${API_BASE}/searches/{id}/report.pdf` etc. — no client-side generation, no auth complications inside the browser.

---

## 5. What this plan deliberately does **not** change

- `backend/` — zero edits. `eddyspapersbackend` keeps its current Plumber routes; the agentic app is a pure consumer.
- `frontend/` — zero edits. The old search UI keeps working at its current URL.
- The existing R MCP server (`backend/R/mcp_server.R`) — left running until the new MCP adapter has been validated for one week of dual-run, per design §7.10. Then deleted.

---

## 6. Build/dev commands (sketch)

From repo root, assuming pnpm workspaces:

```bash
pnpm --filter agentic_backend  dev      # tsx watch src/index.ts
pnpm --filter agentic_frontend dev      # astro dev
pnpm --filter agentic_backend  build    # tsup or tsc
pnpm --filter agentic_frontend build    # astro build
```

R side:

```bash
cd agentic/r/eddysearch.sandbox
devtools::load_all()      # iterate
devtools::test()          # AST allowlist + verb tests
```

---

## 7. Milestone order (refined from design §10)

1. `agentic/r/eddysearch.sandbox` — data verbs + `emit_*` family + FD-3 writer. Confirm DuckDB read-only snapshot path and hardening pragmas. Tests pass.
2. `agentic/r/check.R` — AST allowlist. Unit tests against good/bad script corpora.
3. `agentic_backend/sandbox/` — `runSandbox.ts` + `checkScript.ts`. End-to-end "TS spawns R, gets events back" test. No LLM yet.
4. `agentic_backend/llm/` + `agent/stages/writeScript.ts` — Haiku-via-OpenRouter writer with cached few-shots. Eyeball 20 sample queries end-to-end, no UI.
5. `agentic_backend/agent/runAgent.ts` — full pipeline, event bus, SSE route.
6. `agentic_frontend/` — record an event log from step 5, build the UI against the recording, then connect live.
7. `agentic_backend/mcp/` — `findPapers` (passthrough) first to validate transport; then `litSearch` reusing `runAgent`. Switch coding-agent configs over, dual-run with the old R MCP server for a week, then delete it.
