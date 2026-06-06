# 06 — The blocking clarifier (design)

**Status:** implemented 2026-06-06. A few decisions changed during the build — see the
**Implementation deltas** box below; the affected sections are annotated inline.

> **Implementation deltas (2026-06-06).**
> 1. **Clarifier output is a flat `action` object, not a `{done}` union.** Haiku consistently
>    took the cheapest `{done:true}` branch of the union and never asked, even on the exemplars.
>    The schema is now `{ assessment, action: "proceed"|"ask"|"reject", question?, options?, reason? }`
>    — the model writes a one-sentence assessment first, then commits to an action. This fixed
>    the ask-rate immediately (vague briefs ask, self-contained ones proceed). Supersedes §6's
>    three-way `{done}` schema.
> 2. **The `clarify` event carries `options: string[]`** (2–4 concrete choices). The UI is
>    Claude-Code style: selectable choice chips **plus** a free-text "write your own" field, not
>    the single-line input sketched in §7.2.
> 3. **The web control is a toggle switch labelled "Skip clarifying questions"** (not a checkbox
>    "One-shot — …"). Default off (clarifier enabled). Supersedes §2/§7.1 wording.
> 4. **The 24h expiry sweeper (§9 / build step 8) is not built yet** — deferred. Abandoned
>    `awaiting_clarification` rows simply persist.

**Scope note / precedence.** This is a *feature* design that spans system, prompt, and UX
concerns. Where it touches system architecture (pipeline state machine, SSE protocol, wire
schemas, endpoints) it **extends `01_design.md` and remains subordinate to it** — if a system
detail here ever conflicts with `01_design.md`, the latter wins and this doc should be corrected.
Where it touches surface (the one-shot checkbox, the answer input, microcopy) it follows the
conventions in `03_interface.md`. Prompt wording lives with `04_prompts.md §4`.

---

## 1. Why

Today the clarifier is **cosmetic**. `runAgent` calls `clarify(brief)`; if the model decides to
ask a question it emits a single `assistant` event and then *immediately proceeds to the write
stage anyway*. The frontend renders the question as a read-only amber "Quick note" banner
(`ClarifierBubble.jsx`: "informational in v1 — no reply round-trip yet"). The user's answer is
never collected and never influences the run.

Two consequences, both reported by Eddy (2026-06-06):

1. **It "seldom does something."** The prompt is tuned to *err on the side of proceeding*
   ("a too-broad script is recoverable; a broken loop is not"), so it rarely asks — and when it
   does, nothing changes.
2. **Genuinely ambiguous briefs sail through.** Example: *"What are recent labour-econ papers
   making it to the top-5? What is their unique selling point? Consider papers landing there post
   2023."* — this would benefit from one clarifying question (e.g. "unique selling point relative
   to what — method, data, or topic novelty?") but currently gets a one-shot guess.

The fix is a **real blocking round-trip**: the agent may ask one question, the run *pauses*, the
user answers in the UI, the answer is folded into the brief, and the pipeline resumes. Because
some users (and all MCP callers) want a single shot with no interruption, the behaviour is
**toggleable** via a one-shot control.

---

## 2. The one-shot toggle

A single boolean governs whether the pipeline is allowed to stop and ask.

| Surface | Control | Default |
|---|---|---|
| Web UI | a checkbox in the task box: **"One-shot — skip clarifying questions"** | **unchecked** (clarifier *enabled*) |
| Wire (`POST /chat`) | `skipClarify: boolean` | `false` |
| MCP `lit_search` tool | `skip_clarify: boolean` (already specified in `01_design.md §7.3`) | `true` |

This is deliberately the **same flag** the MCP variant already defines (`01_design.md §7.3`), just
surfaced in the web UI. Naming aligns on `skipClarify` / `skip_clarify`.

Semantics:

- `skipClarify = true` → today's behaviour exactly: the clarify stage runs only as an internal
  *reject-or-proceed* gate (it may still reject off-topic/gibberish briefs), never blocks, never
  asks. No pause, no UI input. This keeps the fast path fast for power users.
- `skipClarify = false` (web default) → the clarify stage may **ask one question and pause**. The
  user opted in to being asked by leaving the box unchecked, so the clarifier prompt is allowed to
  be more willing to ask (see §6).

> Why default the web UI to *clarifier-enabled* but MCP to *skip*: a human at the keyboard can
> answer a one-line question in two seconds and gets a markedly better review for it; a calling
> coding agent cannot block mid-tool-call and has usually already shaped the brief.

---

## 3. Pipeline state machine

The current pipeline is a single fire-and-forget async pass: `clarify → write → validate →
execute → synthesize → done`. The blocking clarifier introduces **one suspension point** between
`clarify` and `write`.

```
                       skipClarify=true ──────────────────────────────┐
                                                                       ▼
  POST /chat ──▶ [clarify] ──proceed/skip──────────────────────▶ [write] ─▶ … ─▶ [done]
                    │
                    ├─ reject ─────────────────────────▶ [error] ─▶ [done]
                    │
                    └─ question (skipClarify=false) ─▶ ❚PAUSE❚  (status: awaiting_clarification)
                                                          │
                                  POST /chat/:id/reply {answer}
                                                          │
                                          (merge answer into brief context)
                                                          ▼
                                                       [write] ─▶ … ─▶ [done]
```

The run is therefore **two-phase** when it pauses:

- **Phase A** (`POST /chat`): run `clarify`. If it returns `question` and `skipClarify=false`,
  emit a `clarify` event, persist `status = 'awaiting_clarification'` plus the pending question,
  and **return without emitting `done`**. The pipeline function exits cleanly; nothing is left
  spinning in memory.
- **Phase B** (`POST /chat/:id/reply`): validate the search is `awaiting_clarification`, append
  the answer to the persisted record, set `status = 'running'`, and invoke the *resume* entrypoint
  that runs `write → validate → execute → synthesize → done`, publishing to the same `searchId`
  bus so the open (or reconnected) SSE stream picks the events up by `seq`.

Two-phase (rather than holding the run alive in memory awaiting a promise) is chosen because it
**survives SSE reconnects and server restarts**, matches the existing persisted `searches` table +
replay-by-`seq` model, and keeps `runAgent` free of long-lived in-memory waiters. The cost is a
small refactor of `runAgent` into `runClarifyPhase` + `runSearchPhase` sharing the emit/stage
helpers.

---

## 4. Wire protocol

### 4.1 New stream event

Add one variant to the `StreamEvent` union (`agentic_backend/src/agent/types.ts`):

```ts
| { type: "clarify"; seq: number; question: string; required: boolean }
```

- Emitted when the clarifier asks and the run is pausing.
- `required: true` when `skipClarify=false` and the run is actually blocked on it (UI must show an
  input). Reserved `required: false` for a future "optional nudge" that doesn't block — not used
  in v1.
- The existing `assistant` event (streamed clarify tokens) is **retired for this purpose**; the
  question text travels in the `clarify` event so the reducer has one unambiguous signal. (Keep
  the `assistant` variant in the union for synthesize-stage streaming if ever needed; it is simply
  no longer produced by the clarify stage.)

The run does **not** emit `done` when it pauses — the absence of a terminal event is what tells the
SSE layer the stream stays open. `bus.isDone(searchId)` must return `false` while
`awaiting_clarification`.

### 4.2 New endpoint

```
POST /chat/:id/reply
  body: { answer: string }   // 1..2000 chars, same bounds as a brief
  200  { ok: true }          // accepted; resume started, watch the SSE stream
  404  search not found
  409  search is not awaiting clarification (already running / done / error)
  400  invalid body
```

Idempotency: a second `reply` to an already-resumed search returns `409`. The frontend disables the
input after the first send.

### 4.3 Start-body change

```ts
const chatBodySchema = z.object({
  brief: z.string().min(1).max(2000),
  skipClarify: z.boolean().optional(),     // NEW — default false
  // categories/minYear/mustInclude unchanged (categories now usually empty — see 04_prompts §3)
});
```

---

## 5. Persistence & caching

`searches` table changes (`agentic_backend/src/db/searches.ts`):

- `status` union gains `'awaiting_clarification'` → `"running" | "awaiting_clarification" | "done" | "error"`.
- Two new nullable columns: `clarify_question TEXT`, `clarify_answer TEXT`.
- `StoredSearch` mirrors these.

New `SearchDb` methods (or extend `upsertSearch`/`finalizeSearch`):

- `setAwaitingClarification(id, question)` → status + question.
- `recordClarifyAnswer(id, answer)` → answer + status back to `running`.

**Cache-key interaction.** `search_id` currently hashes `{brief, categories, minYear,
dbSnapshotDate}` (`agent/cache.ts`). The clarifier answer changes the *effective* brief, so two
runs of the same brief with different answers must not collide. Decision for v1:

- The `search_id` is still computed from the **original brief** at `POST /chat` time (so the
  pre-answer record can be created and streamed).
- The answer is folded into the brief that the **write stage** sees (`"<brief>\n\n<clarification>\nQ: …\nA: …\n</clarification>"`), and stored in `clarify_answer`.
- A *completed* search (`status='done'`) for an identical original brief returns the cached result
  and skips clarify entirely — acceptable, because the answered+completed brief→result mapping is
  what we want to memoise. (Open question §8.1 if we later want answer-sensitive cache keys.)

---

## 6. Prompt changes (`04_prompts.md §4`)

When `skipClarify=false`, the user has opted in to being asked, so the clarifier stance shifts from
*"err on the side of proceeding"* to *"ask one good question when it would change the script"*:

- Keep the three-way output schema unchanged: `{done:true}` | `{done:false, question}` |
  `{done:false, reject, reason}`.
- Soften the "err on the side of proceeding" line to "ask exactly one question when the brief is
  genuinely ambiguous in a way that would change the script's *shape* (e.g. method vs. data vs.
  topic novelty; country scope; which of several plausible readings). Otherwise proceed."
- Add concrete *ask-worthy* exemplars drawn from real ambiguity, e.g. the top-5 USP brief →
  "Unique selling point relative to what — identification strategy, novel data, or a new question?"
- The clarifier still receives the `journalCategories.ts` block (it already does) so it can judge
  whether a tier/scope question is warranted.

When `skipClarify=true`, the clarify call uses the **existing** prompt path but the runtime never
acts on a `question` result (treats `question` as `proceed`). No second prompt variant needed.

The clarifier answer is injected into the **writer** user message as a `<clarification>` block
appended after `<brief>` (see §5). The writer prompt gets one line noting that a `<clarification>`
block, when present, is authoritative and refines the brief.

---

## 7. UX (`03_interface.md`)

### 7.1 One-shot checkbox

A small checkbox lives in the task-box footer, left of (or under) the Run button:

```
 ┌─────────────────────────────────────────────────┐
 │ TASK                                            │
 │ ┌─────────────────────────────────────────────┐ │
 │ │ Describe what you want me to find…          │ │
 │ └─────────────────────────────────────────────┘ │
 │ ☐ One-shot (skip clarifying questions)          │
 │ ─────────────────────────────────────────────── │
 │  ← Semantic mode                         [Run]  │
 └─────────────────────────────────────────────────┘
```

Unchecked by default. Tooltip: "Leave unchecked to let the agent ask one quick question when your
brief is ambiguous." Uses the same muted label tokens as the other hints.

### 7.2 The clarifier turn

`ClarifierBubble` is upgraded from a read-only banner to an **interactive prompt** when a `clarify`
event arrives with `required:true`:

- Render the question, then a single-line input + a small **Send** button (and ⌘/Ctrl+Enter).
- The `StageStepper` holds at the `clarify` step in a distinct **"waiting for you"** state — not
  the spinning "active" state — so it's visually clear the agent is paused, not working.
- On Send → `POST /chat/:id/reply`, disable the input, return the stepper to spinning, and let the
  resumed SSE events drive the rest.
- If the user reloads mid-pause, the SSE replay re-delivers the `clarify` event (it's persisted in
  `events`) and the input re-appears because `status='awaiting_clarification'`.

When `skipClarify=true`, no `clarify` event with `required:true` is ever emitted, so the input
never appears — the run flows straight through as today.

### 7.3 Reducer (`lib/store.js`)

- New `case "clarify"`: set `clarifierQuestion = question` and a `awaitingReply = e.required` flag;
  hold `stages.clarify` in a `"waiting"` value.
- A `done` event clears `awaitingReply`.
- `StageStepper` renders the new `"waiting"` stage value distinctly from `active/done/failed/pending`.

---

## 8. MCP behaviour (unchanged contract)

`01_design.md §7.3` already specifies the MCP semantics; this design must stay consistent:

- `skip_clarify=true` (MCP default): never blocks; infers defaults and proceeds; returns a
  `needs_clarification` structured field only if genuinely ambiguous, so the caller can re-invoke.
- `skip_clarify=false`: returns the clarification question(s) and stops; the agent re-calls with
  answers folded into the brief.

The web reply endpoint is the human-in-the-loop analogue of the MCP "re-call with answers" pattern;
both ultimately resume by feeding a `<clarification>` block into the writer. **No blocking prompts
over MCP — ever.**

---

## 9. Failure modes & edge cases

| Case | Handling |
|---|---|
| User never answers | Search sits in `awaiting_clarification`. A sweeper expires stale awaiting searches after **24h** → `status='error'`, recoverable note. No server-side auto-proceed in v1 (silently guessing defeats the point). |
| Reply after the run was already resumed | `409`; input already disabled client-side. |
| Empty / whitespace answer | `400`; client keeps the input enabled. |
| Reconnect / reload during pause | SSE replay re-delivers the persisted `clarify` event; `status` drives the input's re-appearance. |
| `skipClarify=true` but brief is gibberish/off-topic | clarify still *rejects* (that path is independent of blocking) → `error` + friendly reason, as today. |
| Server restart while paused | State is in DuckDB (`status`, `clarify_question`); the next `reply` resumes cleanly. Nothing relies on in-memory waiters. |
| Clarifier model error | Same as today: fall through to `proceed` (never strand the user on an infra hiccup). |

---

## 10. Build order (feed into `05_roadmap.md`)

A focused phase, dependencies in brackets:

1. **Wire + types** — add `clarify` event, `skipClarify` body field, `awaiting_clarification`
   status, `clarify_question/answer` columns + `SearchDb` methods. [no deps]
2. **Pipeline split** — refactor `runAgent` into `runClarifyPhase` + `runSearchPhase` sharing
   emit/stage helpers; pause path persists and returns without `done`. [1]
3. **Reply endpoint** — `POST /chat/:id/reply`; validates state, records answer, kicks
   `runSearchPhase` onto the same bus. [1,2]
4. **SSE pause semantics** — `bus.isDone` returns false while awaiting; stream stays open / replays
   the `clarify` event on reconnect. [1,2]
5. **Writer injection** — `<clarification>` block appended to the writer user message; one writer
   prompt line. [2]
6. **Clarifier prompt** — soften the proceed-bias when blocking is enabled; add ask-worthy
   exemplars. [no deps]
7. **Frontend** — one-shot checkbox (start body), interactive `ClarifierBubble`, reducer
   `clarify`/`waiting` handling, stepper "waiting" state. [1,3]
8. **Expiry sweeper** — stale-`awaiting_clarification` → error after 24h. [1]

**Acceptance:** with the box unchecked, an ambiguous brief (the top-5 USP example) pauses with an
input, the typed answer visibly changes the resulting strategy/script, and the run completes; with
the box checked, the same brief flows straight through with no input. Reload-during-pause restores
the input. MCP behaviour is unchanged.

---

## 11. Open questions

1. **Answer-sensitive cache key.** v1 keys on the original brief. If we observe the same brief
   getting materially different answers across users, fold a hash of the answer into `search_id`
   (or into a sub-key) so distinct answers cache separately.
2. **More than one question.** v1 caps at one question (matches the current schema and the
   lit-search skill). If real usage shows one question is often not enough, allow up to two
   sequential pauses — the state machine already supports re-entering `awaiting_clarification`.
3. **Auto-proceed timeout.** v1 expires to `error` after 24h rather than guessing. If users find
   the pause annoying, consider an opt-in "answer or it proceeds in 60s" affordance instead.
