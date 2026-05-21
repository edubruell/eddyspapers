# Agentic Search — Interface Design (Note 3)
**Companion to:** `01_design.md`, `02_implementation_plan.md`
**Scope:** how `agenticsearch.eduard-bruell.de` should look and feel, given that the existing Eddy's Papers Semantic Search stays around as the canonical "fast lookup" tool. The agentic UI is an **addon**, not a replacement, and should be visually unmistakably a sibling.

The four screenshots of the current app establish a clear visual vocabulary. The agentic frontend reuses that vocabulary verbatim wherever it can, and only introduces new primitives for things the old UI has no analogue for (the stepper, the streaming script, the synthesis prose).

---

## 1. Visual vocabulary inherited from the existing app

Extracted from the screenshots:

### 1.1 Palette

| Token | Approx. value | Where it shows up |
|---|---|---|
| `--bg-page` | warm cream `#EEE7DA` ish | full-page background, both states |
| `--bg-card` | near-white `#FAF7F0` | the query/results panels |
| `--bg-card-subtle` | `#F4EFE5` | section headers, footer strip |
| `--border-soft` | `#E2DACB` | card outlines, dividers |
| `--text-strong` | `#1F2937` | titles, headlines |
| `--text-muted` | `#6B7280` | "Press ⌘+Enter…", "Database last updated…" |
| `--label-allcaps` | `#374151`, tracking-wider, 11–12px | "QUERY", "JOURNAL CATEGORIES", "RESULTS" |
| `--primary` | navy blue `#1F4E8C` | Search button fill, links |
| `--primary-hover` | `#163E73` | hover state |
| `--pill-on-bg` | light blue `#D6E8F5` | selected category chip fill |
| `--pill-on-border` | `#5B9BD5` | selected chip border |
| `--pill-on-text` | `#1F4E8C` | selected chip text |
| `--pill-off-*` | white fill, `--text-strong` text, `--border-soft` border | unselected chip |
| `--accent-orange` | `#D4602A` | logo wordmark "Eddy's Papers" + "by Eduard Brüll" |
| `--accent-skyblue` | `#7BB7DD` | logo wordmark "SEMANTIC SEARCH" |
| `--similarity-1` | green `#2F9E5C` | result card left bar, high similarity |
| `--similarity-0` | red `#C0463A` | result card left bar, low similarity (interpolated) |

These become CSS variables in `agentic_frontend/src/styles/global.css` and corresponding Tailwind theme extensions. The existing `frontend/` should ideally be refactored to consume the same variables so both apps stay in lockstep — but that's a follow-up; for now agentic copies them.

> **Action item before implementation:** the exact hex values above are eyeballed from the screenshots. Before locking the Tailwind config, read the in-use values out of `frontend/src/styles/` (or whichever stylesheet the existing app uses) and overwrite the table to match exactly. Anything that drifts here breaks the "feels like the same app" goal.

### 1.2 Tailwind config sketch

```js
// agentic_frontend/tailwind.config.mjs
export default {
  theme: {
    extend: {
      colors: {
        page:    "#EEE7DA",
        card:    "#FAF7F0",
        "card-2":"#F4EFE5",
        soft:    "#E2DACB",
        strong:  "#1F2937",
        muted:   "#6B7280",
        primary: { DEFAULT: "#1F4E8C", hover: "#163E73" },
        pill:    { on: "#D6E8F5", "on-border": "#5B9BD5", "on-text": "#1F4E8C" },
        accent:  { orange: "#D4602A", sky: "#7BB7DD" },
        sim:     { hi: "#2F9E5C", lo: "#C0463A" },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: { card: "14px", pill: "999px", btn: "8px" },
      boxShadow:    { card: "0 1px 2px rgba(0,0,0,0.04)" },
    },
  },
};
```
<eddy> Need to recheck the actual ones in use right now to get this exactly right</eddy>

### 1.3 Component primitives to reuse verbatim

These ship as identical (or near-identical) React components in `agentic_frontend/src/components/primitives/`:

- **`SectionLabel`** — uppercase, tracked, dark-gray label (e.g. "QUERY", "RESULTS"). Reused as "TASK", "REVIEW", "EVIDENCE", "REFERENCES".
- **`Card`** — cream-white panel with `border-soft` outline, 14px radius, soft shadow. Wraps every major block.
- **`Pill`** — the category chip in both on/off states. Reused **as-is** for the journal-category filter, which still acts as a hard database restriction the agent must honour (the model receives the selected categories as part of the brief context, not as a section pill it draws itself). **Mode pills are dropped** — the search mode for each section is inferred from the brief and shown only as a small label inside `SectionCard`'s header, not as a separate primitive.

- **`PrimaryButton`** — navy-blue Search button. Reused as "Run" on the agentic landing and "New search" in the sidebar.
- **`GhostButton`** — outlined "Export" / "Share" / "BibTeX" / "More" style. Reused for "Copy BibTeX", "Download PDF", "Show script".
- **`SimilarityBar`** — the 4–6px coloured strip on the left of result cards. Reused for `PaperRow` and inside `SectionCard`'s individual paper rows.
- **`AdvancedDisclosure`** — the "▶ Show advanced filters" collapsible row. Reused for "▶ Show R script" and "▶ Show SQL".
- **`DatabaseFooter`** — "Database last updated on YYYY-MM-DD · FAQ / Imprint". Reused verbatim; same snapshot date logic.

A user who already uses Eddy's Papers should immediately recognise the agentic app as the same family.

---

## 2. The logo and wordmark

The current logo is the standing meerkat holding a paper plus the orange/sky-blue wordmark. The agentic variant gets a **detective meerkat with a magnifying glass examining papers scattered on the ground**, and a parallel wordmark:

```
[detective meerkat]   Eddy's Papers           ← --accent-orange, same script font
                      AGENTIC SEARCH          ← --accent-sky, same all-caps display font
                      by Eduard Brüll         ← --accent-orange, small
```

Possible alternate sub-wordmarks worth considering for the all-caps line (you decide):

- `AGENTIC SEARCH` — straightforward, parallels `SEMANTIC SEARCH`.
- `DETECTIVE MODE` — playful, matches the meerkat sleuth motif.
- `LIT REVIEW AGENT` — descriptive, hints at the deliverable.

My recommendation: **`AGENTIC SEARCH`** as primary, with the detective meerkat doing the implicit "this is the sleuth-y one" job. It keeps the two products parseable as a pair (`SEMANTIC SEARCH` ↔ `AGENTIC SEARCH`) and avoids cute-name drift.

Logo asset goes in `agentic_frontend/public/logo-agentic.png` (Eddy will hand-draw a fresh detective-meerkat illustration via Flux + GIMP, matching the existing meerkat's cel-shaded style; vector version will be produced from that raster).

**Accent colour shift.** The agentic app uses a **slightly different accent colour** for the primary button and `AGENTIC SEARCH` wordmark than the semantic search app. The shift is small enough to read as "same family" but distinct enough that the two tabs are immediately distinguishable side-by-side. Concrete proposal (to be confirmed once we read the real palette out of `frontend/`):

| Token | Semantic search | Agentic search |
|---|---|---|
| `--primary` | navy `#1F4E8C` | indigo-leaning navy, e.g. `#2A4A8E` shifted toward `#2D3FA0` |
| `--accent-sky` | sky `#7BB7DD` | a marginally warmer teal-blue, e.g. `#5FA8C9` |

Everything else (background, text, similarity bar greens/reds, category pill blues) stays identical so the apps still feel like siblings.


---

## 3. Two-phase layout — mirrors the existing app

The current app has a beautiful two-phase pattern: **centered landing** (logo + query card) → **sidebar+results** (logo and controls collapse to a left rail, results fill the right). The agentic UI uses the **exact same transition**, so the muscle memory carries.

### 3.1 Landing state

```
                      ┌─────────────────┐
                      │  [detective     │
                      │   meerkat]      │
                      │                 │
                      │  Eddy's Papers  │
                      │  AGENTIC SEARCH │
                      └─────────────────┘

         ┌─────────────────────────────────────────────────┐
         │ TASK                                            │
         │ ┌─────────────────────────────────────────────┐ │
         │ │ Describe what you want me to find…          │ │
         │ │                                             │ │
         │ │                                             │ │
         │ └─────────────────────────────────────────────┘ │
         │ Press ⌘+Enter or Ctrl+Enter to start.           │
         │                                                 │
         │ JOURNAL CATEGORIES                              │
         │ (Top 5)  (General Interest)  (AEJs)  (Top A)    │
         │ (Top B)  (Other Journals)  (Working Paper)      │
         │                                                 │
         │ ▶ Show advanced filters                         │
         │ ─────────────────────────────────────────────── │
         │                                          [Run]  │
         │  Database last updated on 2026-05-16 · FAQ      │
         └─────────────────────────────────────────────────┘
```

Differences from the existing landing:

- Section label says **`TASK`** instead of `QUERY` — the input expects a *description of what to find* (paragraph-shaped, lit-review-style), not just an abstract to embed. Placeholder reflects that. (Considered `BRIEF` and `SEARCH PROMPT`; `TASK` reads most naturally in German-academic context where the user is delegating work to the agent.)
- Textarea is an **auto-expanding `<textarea>` à la modern LLM chat inputs** — starts at ~3 rows like the existing app, grows as the user types up to a sensible max (~12 rows) before scrolling. No fixed taller default needed.
- Same category pills (still a hard DB restriction passed into the brief), same advanced disclosure, same "Press ⌘+Enter" hint, same DB footer.
- Primary button reads **`Run`** — short, matches the existing app's vocabulary, and the stepper does the work of signalling "this takes a moment".


### 3.2 Working/results state

```
┌─────────────────┐ ┌───────────────────────────────────────────────────┐
│ [det. meerkat]  │ │  ●─●─●─○─○   clarify · write · validate · execute │
│ Eddy's Papers   │ │              · synthesize                         │
│ AGENTIC SEARCH  │ │  Semantic search: 'bureaucratic quality' …        │
│                 │ │  ↳ 15 results in 1.8s                             │
│ TASK            │ │                                                   │
│ [textarea]      │ │ ▶ Show database search script                     │
│                 │ │                                                   │
│ JOURNAL CATS    │ │ ┌───────────────────────────────────────────────┐ │
│ (Top 5)(Gen…)   │ │ │ ▌ KEYWORD SWEEP                               │ │
│ (AEJs)(Top A)   │ │ │   Bureaucratic quality — Top 5 + Field-A      │ │
│ (Top B)         │ │ │   47 total · 25 shown                         │ │
│                 │ │ │   ▌ Cut off from new competition…    sim 1.000│ │
│ ▶ Adv. filters  │ │ │   ▌ Spatial competition and quality… sim 0.832│ │
│                 │ │ │   …                                           │ │
│         [Run]   │ │ └───────────────────────────────────────────────┘ │
│                 │ │                                                   │
│ DB updated …    │ │ ┌───────────────────────────────────────────────┐ │
│ FAQ / Imprint   │ │ │ ▌ SEMANTIC SEARCH                             │ │
│                 │ │ │   …                                           │ │
│ ← Semantic mode │ │ └───────────────────────────────────────────────┘ │
└─────────────────┘ │                                                   │
                    │ ## Literature synthesis                           │
                    │ The literature on bureaucratic quality…           │
                    │                                                   │
                    │ [Export PDF] [Excel] [BibTeX] [Markdown]          │
                    └───────────────────────────────────────────────────┘
```

Sidebar mirrors the existing app exactly: collapsed logo at top, brief textarea, category pills, advanced disclosure, primary action, DB footer. Adds one item at the bottom — **`← Semantic mode`**, a quiet link back to the non-agentic app (more on cross-linking in §6).

The right pane is where the new primitives live:

- **`StageStepper`** at the top, replacing what would have been a results count line. Five dots/labels horizontally; current stage is blue and spinning, prior stages are green checkmarks, future stages are muted. Uses the same `--primary` / `--similarity-hi` / `--muted` palette so it doesn't read as "new design system".
- **`ProgressLine`** under the stepper — one-line "what's happening right now" with the same `--text-muted` colour as "Press ⌘+Enter…" cues.
- **`ScriptPanel`** is an `AdvancedDisclosure` labelled **`▶ Show database search script`**, revealing the syntax-highlighted R code streaming in. Closed by default; users who don't care never see it.
- **`SectionCard`** is a `Card` matching the result-card outline/shadow, with a small mode label in the header (`KEYWORD SWEEP`, `SEMANTIC SEARCH`, `JOURNAL SCAN`, `AUTHOR LOOKUP`, `WORKING PAPERS`) inferred from the script — not a separate pill primitive. **Collapsed by default**: each section is one summary line ("KEYWORD SWEEP — Bureaucratic quality (47 found, 25 shown) ▶") that expands on click into the list of `PaperRow`s. Reasoning: the synthesis is what the user came for; raw sections are an audit trail beneath it, not the headline. See "Reading order" below.
- **`PaperCard`** (expanded `PaperRow`) is **visually identical** to the current `ResultCard`: title, authors, journal+year, abstract, BibTeX + More buttons. This is the single biggest "this feels like the same app" win — users already know how to read this card.
- **`SynthesisPanel`** sits **above the (collapsed) sections** — it is the deliverable; sections are evidence beneath it. It streams markdown via `react-markdown` + `remark-gfm` into the `--text-strong` body type at the same size as existing result abstracts. Two link styles are rendered:
  - **Inline citation links** (`[Author Year](url)`) — the synthesiser emits these on every citation, pointing at the paper's RePEc/IDEAS URL. A rehype pass adds `target="_blank" rel="noopener noreferrer"` so they open in a new tab without losing the reader's place. Style: same `--primary` colour as existing links, subtle underline on hover. The little ↗ glyph after the link text is optional (decide once we see real density — too many arrows clutters prose).
  - **Handle anchors** (`` `RePEc:…` `` in backticks) — auto-linkified by the same rehype plugin to scroll-to the in-page `PaperCard` and expand it. These never open a new tab; they're the right primitive for "see the evidence for this claim below".

  Together: the cited link goes outward to the source; the handle backtick goes downward to local evidence.
- **`ArtifactsToolbar`** is a horizontal row of `GhostButton`s directly under `SynthesisPanel`: `PDF`, `Excel`, `BibTeX`, `Markdown`. Each enables progressively as `artifact` events arrive. Visually identical to the existing top-right `Export` / `Share` buttons.

**Reading order (right pane, top → bottom):**

1. `StageStepper` + `ProgressLine` (during run; collapse to a small "Took 34s ✓" line afterwards).
2. `ScriptPanel` disclosure (closed by default, even when validated).
3. `SynthesisPanel` — the primary deliverable. Always full width, never collapsed.
4. `ArtifactsToolbar` — download buttons.
5. **Evidence sections**: a `SectionLabel "EVIDENCE"` divider, then the collapsed `SectionCard` list. Each opens on click; handle anchors from the synthesis open and scroll into the appropriate card.

This ordering directly answers the layout concern: sections never block the synthesis above the fold; their full content is one click away when the reader wants to verify a citation.

---

## 4. The stepper — the one genuinely new primitive

```
●──●──●──○──○
clarify · write · validate · execute · synthesize
```

States per step:

- **pending** (`--muted` + thin border, no fill)
- **active** (`--primary` fill, dot spinning via CSS animation, label bold)
- **done** (`--similarity-hi` fill, checkmark glyph, label normal weight)
- **failed** (`--similarity-lo` fill, retry counter as a tiny badge "↻ 1")

Stays compact on desktop (one row, ~480px wide); collapses to a vertical list on mobile.

Why a stepper rather than a spinner: the pipeline takes 20–40s and the user benefits from knowing *which* step we're on. A spinner conveys "something is happening"; the stepper conveys "we've already done these three things, we're now thinking through the last two." That distinction is the difference between users staying engaged vs. tab-switching away. 

---

## 5. Typography and spacing

Same as the existing app — there is no reason to diverge:

- Body: `Inter` (or system-ui fallback), 15–16px, line-height 1.55.
- Headings: same `Inter`, weights 600–700.
- All-caps section labels: 11–12px, `letter-spacing: 0.08em`, weight 600, colour `--text-strong` slightly dimmed.
- Card padding: 20–24px desktop, 16px mobile.
- Inter-card gap: 16px.
- Sidebar width: 280–320px on desktop; collapses to a top header on mobile.

---

## 6. Cross-linking — old ↔ new

Both apps should advertise the other without nagging:

**On the existing semantic search page (`frontend/`)**:
- Add a small `GhostButton` in the top-right toolbar, next to `Export`/`Share`: **`🔍 Detective mode →`** linking to `agenticsearch.eduard-bruell.de`. Tooltip: "Let the meerkat write a literature review for you."
- Optional: a one-line strip in the results-state header: "Want a synthesised review of these results? Try Detective Mode." dismissable; cookie-killed after one dismissal. 

**On the agentic page (`agentic_frontend/`)**:
- The sidebar's bottom area carries a quiet **`← Semantic mode`** link back. Tooltip: "Just want to search by abstract? Use classic semantic search."
- The empty-state landing copy can include a one-liner under the brief textarea: "Need a single-query lookup instead? [Try semantic search →]"

The visual mark of distinction between the two is **only the logo** (standing meerkat vs detective meerkat) and the wordmark (`SEMANTIC SEARCH` vs `AGENTIC SEARCH`). Everything else is shared. That's by design.

---

## 7. Microcopy

Voice should match the existing app — minimal, slightly playful where the logo is, otherwise precise:

| Surface | Copy |
|---|---|
| Landing placeholder | `Describe what you're looking for. The more context, the better the review.` |
| Hint under brief | `Press ⌘+Enter or Ctrl+Enter to start.` (same as today) |
| Primary button | `Run search` |
| Stepper labels | `clarify · write · validate · execute · synthesize` (lowercase, casual) |
| Progress line examples | `Reading the brief…` · `Writing search script…` · `Running keyword sweep for "X"…` · `15 results in 1.8s` · `Synthesising review…` |
| Script panel header | `R script` (closed) / `R script (validated ✓)` (open after validate) |
| Validation failure | `Script needed adjustment — retrying.` (muted, never alarming) |
| Section mode labels (inferred, in header) | `KEYWORD SWEEP` · `SEMANTIC SEARCH` · `JOURNAL SCAN` · `AUTHOR LOOKUP` · `WORKING PAPERS` · `EDITOR TARGETS` |
| Empty PaperRow expand | `Expand for abstract, BibTeX, and citations.` |
| Artifacts toolbar | `Export PDF · Excel · BibTeX · Markdown` (same icons as existing Export button) |
| Done state | `Review ready. Took 34s.` (small, `--text-muted`) |
| Error fallback | `Couldn't finish — here's what I have so far.` plus a retry button. |

### 7.1 Paper upload as a brief input (deferred)

A common real-world query is "here's my draft / a paper I read — find related literature, especially things I'm missing." Allowing a **PDF drop** in the `TASK` area is attractive but introduces three costs that should be measured before committing:

1. **Token cost.** A typical economics paper is 12–25k tokens. Including it in the writer prompt roughly **doubles per-query cost** (writer + synthesiser both see it). Cacheable, so a re-run of the same paper is cheap — but the first run isn't.
2. **PDF extraction infra.** We already have `mistral-ocr` and `gemini-extract` skills doing this elsewhere, but on the web side we'd need a tiny upload endpoint, size limits, and a temp store.
3. **Sandbox surface.** The R script doesn't need the PDF — only the brief-shaping stage does. So the PDF lives entirely in the orchestrator's prompt context; the sandbox stays pure.

**Recommendation:** keep upload **out of v1**. Add it once the per-query cost picture is stable (see model selection in `02_implementation_plan.md` §2.1). When added, the UX is a single ghost button under the task box ("📎 Attach paper for context"), the file is extracted to markdown server-side, and the writer prompt gets a `<paper>` block prepended. Synthesiser then *also* knows to flag "papers you should probably cite but didn't".

---

## 8. Mobile

The current app degrades gracefully to a single-column on narrow viewports; the agentic UI follows the same approach:

- Sidebar becomes a collapsed top header with the logo, brief textarea, and a "Refine" expand button revealing category pills + advanced filters.
- Stepper goes vertical, sections stack full-width.
- ScriptPanel collapsed by default (it already is on desktop; on mobile it stays collapsed even after open-by-default would have applied).
- Synthesis panel always full-width.

No special mobile design is needed — the same primitives at narrower sizes work.

---

## 9. What we explicitly don't change vs. the old UI

- Card shape, border, shadow, radius.
- Pill shape, fill rules, border weight.
- Primary blue button, ghost button.
- Section label typography (`QUERY` → `TASK` is the only swap).
- DB footer line.
- Result card visual identity (title, authors, journal+year italic, abstract, BibTeX/More).
- Similarity bar on left of each result.
- Sidebar → centered transition pattern.

Anyone who has used Eddy's Papers Semantic Search should be productive in Agentic Search within seconds; the only thing to learn is the stepper and the synthesis panel, both of which announce themselves.

---

## 10. Resolved interface decisions

1. **Clarifier turn UI — inline.** When the agent has one clarifying question, render it as an inline "Quick question:" prompt with a tight reply box that submits on Enter. No chat bubbles. Matches the existing app's non-chatbot tone.

2. **Task textarea during a run — frozen read-only.** Once `Run` is pressed, the textarea greys out and becomes read-only for the duration of the run; a small `New search` button in the sidebar starts a fresh session (clears the textarea + opens a new `/c/<id>`). This is simpler than the editable-with-restart pattern and avoids the "did my edit take effect?" ambiguity. Worth revisiting if user testing shows people *want* to tweak mid-run.

3. **Past searches & sharing — yes, with a storage budget.** Permalink-friendly `/c/<search_id>` URLs are mandatory (we already content-address by `search_id`). A `History` reveal in the sidebar listing the user's recent searches is added in v1, but storage is bounded:
   - Cap stored runs to **N most recent per IP/key** (start: 100) + **all runs ever generated from the MCP transport with an auth key**.
   - Auto-prune anonymous web runs older than 30 days.
   - Structured payloads are small (~50–200 KB); PDF/XLSX artifacts are regenerated on demand from the payload, never stored as primary state. With these limits, even 10k retained searches fit in a few GB.
   - The same `/c/<id>` URL serves as the **share link** — anyone with the URL can read the synthesis + sections + artifacts but cannot re-run.

4. **Detective meerkat asset — Eddy hand-makes it.** Same workflow as the standing meerkat: Flux/Black Forest Labs base + hand-drawn references + GIMP touch-up. No frontend mockup until the asset exists; a placeholder SVG ships in the meantime.

5. **Cross-link prominence — small button + dismissable banner.** The semantic-search app gets the small `Detective mode →` button next to `Export`, plus a one-line dismissable banner on first visit ("New: let the meerkat write a review →"). Cookie-killed after dismissal. Eddy will additionally promote via ZEW channels + LinkedIn at launch.

---

## 11. Component file map (frontend, refined)

Reflects the primitives discussion above:

```
agentic_frontend/src/components/
├── primitives/                # mirror what the existing app uses
│   ├── Card.jsx
│   ├── Pill.jsx
│   ├── PrimaryButton.jsx
│   ├── GhostButton.jsx
│   ├── SectionLabel.jsx
│   ├── SimilarityBar.jsx
│   ├── AdvancedDisclosure.jsx
│   └── DatabaseFooter.jsx
│
├── chat/                      # the genuinely new layout
│   ├── SearchChat.jsx         # root island
│   ├── Sidebar.jsx            # logo + BriefPanel + categories + adv + Run + DB footer + ← Semantic mode
│   ├── BriefPanel.jsx         # the brief textarea + hint
│   ├── CategoryPills.jsx      # reused logic from the old app
│   ├── AdvancedFilters.jsx
│   ├── StageStepper.jsx
│   ├── ProgressLine.jsx
│   ├── ScriptPanel.jsx
│   ├── ClarifierBubble.jsx    # inline "Quick question:" prompt
│   ├── SectionCard.jsx
│   ├── PaperRow.jsx
│   ├── PaperCard.jsx          # ≈ visually identical to old ResultCard
│   ├── SynthesisPanel.jsx
│   ├── BibtexDrawer.jsx
│   ├── ArtifactsToolbar.jsx
│   └── ErrorToast.jsx
│
└── logo/
    └── LogoAgentic.jsx        # detective meerkat + wordmark
```

The `primitives/` set is the contract: if we ever align the existing `frontend/` to share these (via a small shared package), both apps stay in lockstep automatically.
