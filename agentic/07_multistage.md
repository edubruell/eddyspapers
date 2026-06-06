# 07 — Multistage (results-aware re-running)

**Status:** design only — no code yet. Decided 2026-06-06.

**Scope note / precedence.** This is a *feature* design that spans system, prompt, and UX
concerns. Where it touches system architecture (the `runAgent` pipeline, SSE protocol, wire
schemas, sandbox budget) it **extends `01_design.md` and remains subordinate to it** — if a system
detail here ever conflicts with `01_design.md`, the latter wins and this doc should be corrected.
Where it touches surface (the re-entrant stepper, the "refining" sub-state, microcopy) it follows
the conventions in `03_interface.md`. Prompt wording lives with `04_prompts.md`. This doc resolves
open question `01 §9.5` ("citation-aware iteration … cap at 3 script rounds") and supersedes the
deferred note at `05_roadmap.md` line ~356.

---

## 1. Why

Today the pipeline is **single-shot**: `runAgent` does clarify → write → validate → execute →
synthesize, runs **one** script, and synthesizes whatever comes back. The writer is now guided to
*chain verbs inside that one script* (find → resolve-versions → rank-by-stats; see the ZEW example
in `04 §2.4` / `examples.ts`), which covers most "compose several queries" briefs. But chaining only
helps when the right strategy is **knowable in advance**. It is not always.

### 1.1 The motivating case (reproduced 2026-06-06)

Brief: *"What are the most successfully published ZEW discussion papers in the last five years?"*

The writer produced a sound script that took the **newest** ZEW DPs (`ORDER BY year DESC LIMIT
200`) and tried to resolve their published journal versions. The published set came back **empty** —
because the WP→journal lag is 2–4 years, so the *newest* DPs are exactly the ones not yet published.
The run "succeeded" (exit 0) but the headline section had 0 rows.

The single-script fix was to inject a **domain insight** into the prompt: "don't sort by recency;
the published subset skews to the older end of the window; resolve via a `version_links` SQL join."
With that hint the writer now nails it (Econometrica, four AEJs, JOLE/JAR/JPubE/Research Policy…).

The point: **getting the one-pass script right required a human to know the answer's shape and
patch the prompt.** A results-aware agent would not need that — it would run the naive script, *see*
the empty section, reason "my recency filter selected unpublished papers," and re-run with a
corrected strategy. That self-correction is what this feature adds.

### 1.2 What multistage is and is not

- It **is** a bounded loop that lets the agent observe its own results and revise its *strategy*
  once or twice when a pass clearly underperforms.
- It is **not** a replacement for single-script chaining. Chaining stays the first-class default
  (cheaper: one LLM write + one sandbox run). Multistage is the escape hatch for when the correct
  strategy is unknowable until data comes back — empty intermediate joins, too-tight filters,
  surprising distributions, "expand from these seeds via citations."
- It is **not** streaming intermediate script state to the UI (`01 §9.3` stands): each round still
  waits for the sandbox's JSON blob; only the *final* synthesis streams tokens.

---

## 2. Architecture

A new **assess** step turns the linear pipeline into a bounded loop around write→validate→execute:

```
clarify
  └─► [ write → validate → execute → assess ]   ◄─ loop, ≤ MAX_ROUNDS
                                       │
                          adequate ────┴──► synthesize → done
                          revise   ────────► (next round, with feedback)
```

- **Round 1 always runs** exactly as today.
- After execute, **assess** decides `adequate` vs `revise`. On `revise` it also emits a short
  *revision directive* (plain prose: what to change), and the loop returns to **write** carrying
  the prior script, a compact result summary, and that directive.
- The loop stops on `adequate`, on hitting `MAX_ROUNDS`, or on a degenerate round (see §5).
- Results **accumulate** across rounds (§4), so a useful round-1 pass is never thrown away.

This reuses the existing machinery: `executeScript` is unchanged; `writeScript` gains a second
feedback channel (§6) parallel to its existing validation-retry path; only `runAgent` grows the loop
and the new assessor stage joins it.

---

## 3. The assess step

A cheap, cached LLM call (Haiku, like clarify/synth) plus deterministic pre-flags.

**Inputs:** the brief; the round number; the script that just ran; and a *result summary* — section
titles with row counts, total distinct papers, count of newly-added papers this round, and a small
sample (≤ 5) of result rows (title/journal/category/year). Never the full papers payload — keep the
assessor prompt small and cacheable.

**Deterministic pre-flags (no LLM):** computed from the execute result and handed to the assessor as
structured hints so it isn't guessing:
- `all_empty` — zero papers across all sections.
- `headline_empty` — the last/primary section returned 0 rows while an earlier section did not
  (the ZEW symptom: candidates found, resolution produced nothing).
- `thin` — total distinct papers below a small threshold (e.g. < 5) for a brief that implies breadth.
- `no_new` — this round added 0 papers over prior rounds.

**Output schema** (structured, validated):
```ts
{ verdict: "adequate" | "revise",
  reason: string,            // one sentence, user-facing (the `revise` event text)
  directive?: string }       // present iff verdict === "revise"; what to change, in prose
```

**Tuning (mirror the clarifier's bias toward not-acting).** The assessor must **err toward
`adequate`**. A decent-but-imperfect result is done; only `revise` when the result is empty, thin,
or visibly off-brief AND the assessor can name a concrete, *different* strategy. Marginal "could be
slightly better" is not grounds for another round — rounds cost a full write+sandbox cycle.

To save a round-trip in the obvious case, `all_empty`/`headline_empty` may **short-circuit to
`revise`** without the LLM when round < MAX_ROUNDS; the assessor is still called to produce the
directive. (Implementation may fold this into one call that receives the flags — simpler than two
code paths.)

---

## 4. Result accumulation

Papers and sections **union across rounds**, deduped by handle — the same dedup the `emit_*` model
already does within a single run, lifted to the run level. Concretely, `runAgent` keeps the
cross-round `papers` map and `sections` list and merges each round's `executeScript` output into it.

Two revision shapes the directive can express, distinguished by one field:
- **`augment`** (default): keep prior results, this round *adds* (e.g. "expand from the round-1 seeds
  via `citedby`"). New sections append; overlapping papers dedup.
- **`replace`**: the prior approach was wrong (the ZEW newest-first case); discard the offending
  section(s) and re-derive. The directive names what to drop.

Synthesis runs **once**, at the end, over the accumulated set — never per round.

---

## 5. Caps and termination

- **`MAX_ROUNDS = 3`** total execute rounds (per `01 §9.5`). Web default 3; MCP / one-shot default 1
  (no interruption, no extra latency — consistent with the clarifier's one-shot spirit, `06 §2`).
- **Early stop:** `verdict === "adequate"`.
- **Degenerate stop:** a `revise` round that yields `no_new` *and* whose follow-up directive repeats
  the prior one (same normalized text) → stop and synthesize what we have. Prevents spinning.
- **Sandbox budget:** each round is one `executeScript` (90 s cap). In multistage, lower the
  per-round timeout (e.g. 60 s) so worst-case wall-clock stays bounded; the total run also carries
  an overall deadline. A round that *times out* is treated like `all_empty` for assessment.
- **Token budget:** the added cost is one Haiku assessor call per round plus one extra
  write+execute per revise. The common case (round 1 adequate) adds only the single assessor call.

---

## 6. Writer feedback channel

The writer already has a **validation-retry** path: on AST/SQL rejection it gets `<previous_attempt>`
+ `<rejection>` and tries again (`04 §3`). Multistage adds a **distinct, parallel** channel — the
script was *valid and ran*, but the *strategy* underperformed:

```
<previous_run>
  <script>…the script that ran…</script>
  <result_summary>sections + counts + sample rows…</result_summary>
</previous_run>
<revision mode="augment|replace">…the assessor's directive…</revision>
```

The writer prompt gets a short block teaching the difference: `<rejection>` = "your code was
invalid, fix the code"; `<revision>` = "your code was fine, change the *approach* as directed,
reusing what already worked." Keep both channels visually separate so the model never conflates a
syntax fix with a strategy pivot.

These blocks are per-call context (`04 §3`), not cached corpus — they change every round.

---

## 7. Wire protocol & persistence

One new stream event, plus a `round` tag on the repeating stage events:

- **`revise`** `{ type: "revise"; seq; round; reason; mode }` — emitted when entering round *n+1*.
  `reason` is the assessor's one-sentence, user-facing explanation ("First pass found the working
  papers but none had a published version yet — widening to the full five-year window."). This is the
  multistage analogue of the `strategy` event (`01 §`/`runAgent`).
- Existing `stage` (`enter`/`exit`), `strategy`, `script`, `validate`, `paper`, `section` events
  **repeat per round**; add an optional `round: number` field so the frontend can group them. Seqs
  remain globally monotonic (replay-by-seq in `sse.ts` is unaffected).
- **`assess`** is internal — it does not need its own public event; its outcome surfaces either as a
  `revise` event (loop continues) or simply by proceeding to `synthesize` (loop ends).

**Persistence (`searches` table, `db/searches.ts`).** Events already serialize to the `events`
column, so additional rounds persist for free. Add nothing structural; optionally store
`rounds_run INTEGER` for analytics. Resume/replay is unaffected (events carry everything).

---

## 8. UX (extends `03_interface.md`)

The stepper becomes **re-entrant**. When a `revise` event arrives:
- The stepper shows a brief "Refining strategy…" sub-state and the `reason` line (amber, like the
  clarifier note but informational and auto — no input).
- Write/validate/execute pips re-animate for round *n+1*; completed rounds collapse to a thin
  "Pass 1 ✓ · Pass 2" breadcrumb so the history is visible but not noisy.
- Results from earlier rounds stay on screen and *grow* (accumulation, §4) rather than flashing away.

This is a transparency win: the user watches the agent notice a weak result and adjust — exactly the
"detective thinking out loud" feel the product is going for (`00`, `03`). Microcopy stays plain and
never leaks mechanics (no "version_links", "join", "section returned 0 rows"): "The first pass turned
up few published versions, so I'm widening the search."

**One-shot.** The same control family as the clarifier (`06 §2`): a setting can pin `MAX_ROUNDS = 1`
for users who want a single deterministic pass. MCP callers default to 1.

---

## 9. Relationship to single-script chaining (keep the default cheap)

The writer prompt must still **prefer to do everything in one script**. Multistage is not a license
to write thin round-1 scripts and lean on the loop — that triples cost for no gain. Guidance:
- Round 1 should be the writer's genuine best single-script attempt (chaining included).
- The loop exists for the *unknowable-in-advance* cases, not as a substitute for thinking.
- The assessor's bias toward `adequate` is what keeps the common case at one round.

If telemetry later shows most briefs converge in one round (expected), multistage is pure upside:
near-zero added cost on easy queries, recovery on the hard ones.

---

## 10. Failure modes

| Mode | Mitigation |
|---|---|
| Loop never converges | Hard `MAX_ROUNDS = 3`; degenerate-stop on repeated directive (§5). |
| Assessor always says `revise` | Cap + bias-to-adequate prompt; degenerate-stop. |
| Each round runs the sandbox → slow | Lower per-round timeout (60 s); overall run deadline; round-1-adequate is the common path. |
| Accumulated papers explode | Output-size cap (`01 §8`) already bounds it; cross-round dedup by handle. |
| `replace` discards good results | Directive must name *which* section to drop; default is `augment`, not `replace`. |
| Revision conflated with validation retry | Separate `<revision>` vs `<rejection>` blocks + explicit prompt note (§6). |
| Non-determinism on resume | All rounds' events persisted in `searches.events`; replay-by-seq unchanged. |

---

## 11. Build order

1. **Result summary + deterministic flags** — pure function over `ExecuteResult` → `{ sections,
   counts, sample, flags }`. Unit-tested; no LLM.
2. **Assessor stage** — cached prompt + structured-output schema (§3); returns `verdict/reason/
   directive/mode`. Bias-to-adequate; short-circuit flags.
3. **Loop in `runAgent`** — wrap write→validate→execute→assess; cross-round accumulation (§4); caps
   and degenerate-stop (§5). Synthesize once at the end over the merged set.
4. **Writer feedback channel** — `<previous_run>` + `<revision>` per-call blocks; prompt note
   distinguishing them from the retry path (§6).
5. **Wire + persistence** — `revise` event; `round` field on stage events; optional `rounds_run`.
6. **Frontend** — re-entrant stepper, "refining" sub-state, accumulating results, one-shot pin (§8).
7. **Eyeball/eval** — `eyeball` already prints per-round if the loop runs; add a multi-round view and
   wire the ZEW brief as the canonical acceptance test (§12).

Dependencies: none new. Reuses `executeScript`, `writeScript` plumbing, the searches table, and the
SSE bus. Sits cleanly after the clarifier (`06`) but is independent of it.

---

## 12. Acceptance test (the ZEW benchmark)

With multistage **on** and the *naive* ZEW prompt (newest-first, no domain hint), the run must:
1. Round 1: produce the candidate WPs but a `headline_empty` published section.
2. Assess: `revise`, mode `replace`, directive naming the recency-sort pitfall.
3. Round 2: resolve via the full window (or `version_links` join) and return a non-empty,
   tier-led ranking.
4. Synthesize once over the round-2 result.

This is the regression that proves the loop earns its cost: a query that needs a human prompt-patch
today should self-correct with multistage on. Keep it green whenever the writer corpus changes.

---

## 13. Open questions

1. **Assessor model.** Haiku is the default; a thin brief→verdict task. If `revise` precision is
   poor (spins or misses), try Sonnet for assess only — it gates expensive rounds, so a smarter
   gate may pay for itself. Measure before upgrading.
2. **Per-round timeout.** 60 s proposed; confirm against real multi-round wall-clock once built.
3. **Augment vs replace inference.** Should `mode` come from the assessor (LLM judgment) or be
   derived from flags (`headline_empty` → replace, `thin`/`no_new` → augment)? Start with assessor
   output; fall back to flag-derived if the model is unreliable.
4. **Interaction with the blocking clarifier (`06`).** If a brief was clarified, does the answer also
   feed every revise round's writer context? Yes — the folded brief is the brief from round 1 on.
