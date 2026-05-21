# TypeScript Functional Coding Guidelines

> Style reference for Claude Code working on this project.
> Rooted in purrr/rlang/S7 sensibilities: pure functions, typed pipelines,
> data-first design, dispatch via discriminated unions.

---

## Core Philosophy

- **Functions over classes.** Classes only for stateful identity or factory namespacing — never for bundling data with behaviour.
- **Data shapes are `type` / `interface`.** Behaviour lives in separate pure functions that operate on those shapes.
- **No loops.** Use `pipe` + array combinators (`map`, `filter`, `reduce`, `flatMap`). A `for` loop is a code smell.
- **No mutation.** Spread to produce new objects. Never reassign object properties in place.
- **Explicit over implicit.** No `any`. No `as` casts unless unavoidable (and then always with a comment explaining why).

---

## Stack Choices

| Need | Library |
|---|---|
| Pipelines + array combinators | `effect/Array` + `pipe` from `effect` |
| Missing values | `effect/Option` (`O.fromNullable`, `O.map`, `O.getOrElse`) |
| Typed errors | `effect/Either` or Effect's typed error channel |
| Async + error handling | `Effect` (prefer over raw `Promise` for non-trivial flows) |
| Plain data transforms | `remeda` (`R.pipe`, `R.filter`, `R.map`, `R.sortBy`) |
| HTTP / server | Hono |
| Schema validation | `zod` |

---

## Types and Data Shapes

### Prefer `type` aliases for plain data

```typescript
type Paper = {
  handle:  string
  title:   string
  year:    number
  authors: string[]
}

type Section = {
  title:   string
  mode:    SectionMode
  papers:  Paper[]
}
```

### Use discriminated unions for dispatch

This is the S7 `method(generic, signature)` pattern — but checked at compile time.
Add a variant and every unhandled `switch` becomes a type error immediately.

```typescript
type StreamEvent =
  | { kind: 'paper';    seq: number; paper: Paper }
  | { kind: 'section';  seq: number; section: Section }
  | { kind: 'note';     seq: number; markdown: string }
  | { kind: 'artifact'; seq: number; format: ArtifactFormat; url: string }
  | { kind: 'error';    seq: number; message: string }

const handleEvent = (ev: StreamEvent): void => {
  switch (ev.kind) {
    case 'paper':    return renderPaper(ev.paper)
    case 'section':  return renderSection(ev.section)
    case 'note':     return renderNote(ev.markdown)
    case 'artifact': return enableDownload(ev.format, ev.url)
    case 'error':    return showError(ev.message)
    // TS errors here if a case is missing — never omit the exhaustiveness check
  }
}
```

### Use type guards to narrow through filters

```typescript
type PaidOrder  = Order & { status: 'paid' }

const isPaid = (o: Order): o is PaidOrder => o.status === 'paid'

// PaidOrder[] flows out — not just Order[]
const paidTotals = pipe(
  orders,
  A.filter(isPaid),   // narrowed to PaidOrder[]
  A.map(o => o.total)
)
```

---

## Pipelines

Always use `pipe` for multi-step transforms. Never nest function calls.

```typescript
import { pipe }  from 'effect'
import * as A    from 'effect/Array'
import * as O    from 'effect/Option'

// ✅ readable left-to-right pipeline
const activePapers = pipe(
  rawPapers,
  A.filter(p => p.year >= minYear),
  A.map(normalisePaper),
  A.sortBy(p => -p.year),
  A.take(25)
)

// ❌ nested — never do this
const activePapers = take(25)(sortBy(p => -p.year)(map(normalisePaper)(filter(...))))
```

---

## Handling Missing Values

Use `Option<T>` — never rely on `null` / `undefined` propagating silently.

```typescript
import * as O from 'effect/Option'

const findPaper = (handle: string, papers: Paper[]): O.Option<Paper> =>
  O.fromNullable(papers.find(p => p.handle === handle))

// Forces the caller to handle the absent case
pipe(
  findPaper('repec:abc:123', papers),
  O.map(formatCitation),
  O.getOrElse(() => '[paper not found]')
)
```

---

## Error Handling

Prefer typed errors over thrown exceptions in domain logic.

```typescript
import * as E from 'effect/Either'

type ScriptError =
  | { tag: 'validation'; reason: string; hint: string }
  | { tag: 'timeout';    after_ms: number }
  | { tag: 'oom' }

const runScript = (src: string): E.Either<ScriptError, SectionEvent[]> => {
  // ...
}

pipe(
  runScript(userScript),
  E.match({
    onLeft:  err => handleScriptError(err),
    onRight: events => processEvents(events)
  })
)
```

For async + multi-stage flows with dependency injection, use `Effect` directly.

---

## Pure Functions

Every function must be:

- **Deterministic** — same inputs, same output, always.
- **Side-effect-free** — no I/O, no mutation, no global state. Push effects to the boundary.
- **Focused** — does one thing, named after what it returns or transforms.

```typescript
// ✅ pure, testable in isolation
const normalisePaper = (p: Paper): Paper => ({
  ...p,
  title:   p.title.trim(),
  authors: p.authors.map(a => a.trim()).filter(Boolean)
})

// ❌ impure — hides a side effect
const normalisePaper = (p: Paper): Paper => {
  console.log('normalising', p.handle)   // side effect
  return { ...p, title: p.title.trim() }
}
```

---

## Testing

Test pure functions at their type boundary — input type in, output type out. No mocks,
no setup, no teardown.

```typescript
describe('normalisePaper', () => {
  it('trims title and author whitespace', () => {
    const result = normalisePaper({
      handle:  'repec:abc:123',
      title:   '  Monetary Policy  ',
      year:    2022,
      authors: ['  Smith, J. ', 'Jones, A.']
    })
    expect(result.title).toBe('Monetary Policy')
    expect(result.authors).toEqual(['Smith, J.', 'Jones, A.'])
  })
})
```

Cover the **attack surface** of each function:

- Nominal case
- Empty / zero inputs
- Boundary values (first/last element, zero, max year)
- Invalid shapes caught by type guards

If a function needs mocks, it probably has a side effect that should be moved out.

---

## Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Types / interfaces | PascalCase | `SearchResult`, `SectionMode` |
| Functions | camelCase, verb-noun or predicate | `normalisePaper`, `isPaid`, `findSection` |
| Pure predicates | `is*` / `has*` | `isActive`, `hasCitations` |
| Type guards | `is*` with return `x is T` | `isPaidOrder` |
| Constants | SCREAMING_SNAKE or camelCase | `MAX_RESULTS`, `defaultTimeout` |
| Files | kebab-case | `run-sandbox.ts`, `stream-events.ts` |

---

## What Not To Do

```typescript
// ❌ for loops
for (const p of papers) { results.push(transform(p)) }

// ❌ mutation
paper.title = paper.title.trim()

// ❌ any
const result: any = doSomething()

// ❌ silent null propagation
const name = user?.profile?.name   // fine in templates; not in domain logic — use Option

// ❌ classes for data + behaviour bundles
class Paper {
  constructor(public title: string) {}
  normalise() { this.title = this.title.trim() }  // mutation + bundled behaviour
}

// ❌ nested callbacks / promise chains — use Effect or pipe
fetch(url).then(r => r.json()).then(d => process(d)).catch(...)
```

---

## Project-Specific Notes

- **FD-3 event stream from R sandbox** is the source of `StreamEvent[]` — parse with zod,
  assign `seq` in the TS orchestrator, never trust ordering from R.
- **`search_id`** is a pure hash over `{brief, modes, filters, db_snapshot_date}` —
  compute it as a pure function, never inline.
- **Synthesiser stage** consumes `Section[]` + `Paper[]` as plain typed arrays —
  keep the data extraction from SSE events in its own pure function so the synthesiser
  stage is independently testable.
- **MCP adapter** and **web SSE** consume the same `StreamEvent` union — the switch
  dispatch above is the pattern; no duplicated pipeline logic.
