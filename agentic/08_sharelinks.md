# Agentic Search — Share links (Note 8)

**Status:** building 2026-06-07. Extends `01_design.md` (system) and `03_interface.md` (surface);
subordinate to them on conflict. Realises the Phase 12 bullet *"Share links = same `/c/<id>` URL,
read-only for visitors."*

## 1. The point

A completed run is worth sending to a colleague. A share link opens that run **read-only** for a
visitor who does **not** have the preview password — viewing a stored result costs nothing, so it
sits outside the auth gate. The viewer can read the synthesis + evidence and download the
client-side artifacts (PDF / BibTeX / Markdown); they cannot run new searches.

## 2. Why this is a persistence read, not a stream replay

The live result UI (`useAgentStream`) subscribes to the SSE stream, which replays from the
**in-memory `EventBus`**. That bus is process-local: after a server restart — or for any visitor who
wasn't watching the original run — `bus.subscribe` finds an empty entry and the stream delivers
nothing but heartbeats. The authoritative copy of a finished run is the `events` array persisted in
`searches.duckdb`. So the share view reads `GET /searches/:id` (persistent, restart-proof, ungated)
and replays the events **client-side** through the same `reduceEvent` reducer the live UI uses. One
reducer, two sources (live SSE vs. stored JSON) → identical rendered state, no second render path.

## 3. Backend

- **`GET /searches/:id`** (already mounted ungated). Returns a lean share DTO:
  `{ id, brief, status, createdAt, minYear, categories, events }`. `404` when unknown.
  `events` is the canonical replay payload (it already contains strategy, sections, papers, bibtex,
  synthesis deltas, and the terminal `done`). No new persistence — `upsertSearch`/`appendEvents`
  already store everything.
- Stays **outside `requireAuth`**: a stored result is free to serve, and the `search_id` (a hash over
  `{brief, categories, minYear, db_snapshot_date}`) is unguessable enough for a preview. Running a
  search — the only thing that spends tokens — remains gated.

## 4. Frontend

- **Route:** `/c?s=<id>` (page `src/pages/c.astro`, **not** wrapped in `AppGate`). Query-param form
  is chosen so it works on a plain static host with no SSR adapter and no rewrite rules; the prettier
  `/c/<id>` form is a one-line reverse-proxy rewrite deferred to Phase 10 (deploy).
- **`SharedSearch.jsx`:** fetches the DTO, folds `events` via `initialState`+`reduceEvent`, and renders
  the read-only result reusing the existing presentational components — `LogoAgentic`, `StrategyPanel`,
  `SynthesisPanel`, `ArtifactsToolbar`, `SectionCard`. No `Sidebar`, no run controls. Shows the brief
  as read-only context and a "Run your own search →" link to `/`.
- **`ArtifactsToolbar` gains `serverExports` (default true).** The shared view passes `false` to hide
  the **Excel** button — it's the only server-rendered export and `POST /export/xlsx` is auth-gated, so
  a password-less visitor can't use it. PDF / BibTeX / Markdown are client-side and stay.
- **Share button:** lives at the **top of the results list** in `SearchChat` (results state, once the
  run is `done`). Copies `${origin}/c?s=${id}` to the clipboard (same `navigator.clipboard` pattern as
  `PaperCard`'s BibTeX copy).

## 5. Out of scope (here)

- Sidebar history of past runs (separate Phase 12 item; share is the permalink primitive it builds on).
- Per-user ownership / private shares — the auth model is a single shared password, so there is no
  "owner key" to scope against. Revisit if/when real accounts land.
- The pretty `/c/<id>` URL (Phase 10 rewrite) and SSR.
