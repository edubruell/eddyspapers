# API keys & client setup

Phase 4 replaces the single shared password with **scoped API keys** (PLAN.md §D). This
covers issuing keys and pointing an MCP client at the server.

## Concepts

- Keys look like `esk_<random>`. Only their SHA-256 digest is stored — the plaintext is
  shown **once**, at creation, and is not recoverable.
- **Scopes** gate what a key may do:
  - `rest` — `/chat`, `/papers/*`, `/export/*`
  - `mcp` — the `/mcp` endpoint (all MCP tools)
  - `lit_search` — the expensive `lit_search` MCP tool (checked on top of `mcp`)
  - `admin` — `/stats/*` and `/admin/keys` (key management, telemetry)
- **Rate limits** are per key: `lit_search` 30/h + 300/day + 1 concurrent;
  `find_papers`/`find_people` 600/h; SQL-only tools 6000/h. A cache hit costs no quota.
  Per-key hourly overrides live in the key's `rate_limit_overrides`.
- The gate is **off** when neither `AGENTIC_PASSWORD` nor any key exists (local dev). The
  legacy `AGENTIC_PASSWORD` still works everywhere (all scopes) during the transition.

## Storage

Keys live in a Hono-owned read-write `appdata.duckdb` (default `data/agentic/appdata.duckdb`,
override with `AGENTIC_APPDATA_PATH`). DuckDB takes an exclusive cross-process lock, so **only
the running server opens it** — key management goes through the server's `/admin/keys` routes,
not a second process touching the file.

## Issuing keys — `npm run keys`

The CLI is a thin HTTP client for `/admin/keys`. Point it at the server and authenticate with
an admin credential (the bootstrap admin is `AGENTIC_PASSWORD` in prod; the gate is open in
dev before the first key exists).

```bash
# env: AGENTIC_API_BASE (default http://127.0.0.1:8001)
#      AGENTIC_ADMIN_TOKEN (falls back to AGENTIC_PASSWORD)
export AGENTIC_ADMIN_TOKEN=<the admin password or an admin-scoped key>

npm run keys -- new "Alice (ZEW)" --scopes rest,mcp,lit_search
npm run keys -- list [--all]
npm run keys -- revoke <id-or-hash-prefix>
```

`new` prints the plaintext key once — hand it to the user over a secure channel. `revoke`
takes effect immediately (the server refreshes its registry on the mutation).

> **Bootstrap note.** Always keep `AGENTIC_PASSWORD` set in prod: it is the admin credential
> the CLI uses, and it prevents locking yourself out if you never mint an `admin`-scoped key.

## Issuing keys — admin web page

The same three `/admin/keys` routes back a small operator page in `agentic_frontend` at
**`/admin`**. It lists issued keys (label, scopes, id, created, state), mints new ones (label
+ scope pills), reveals the plaintext **once** in a copy-to-clipboard modal, and revokes with
an inline confirm. The admin token is entered on the page and stored in `localStorage` under a
key **separate** from the search-app token, so a colleague using the search UI never carries
admin rights.

- The label is free text — write *whom* the key is for (e.g. `Alice Müller (ZEW) — alice@…`);
  the list reads it straight back so you can see who holds what.
- Same bootstrap rule as the CLI: on 401/403 the page shows a lock screen asking for an
  admin-scoped key (the prod `AGENTIC_PASSWORD` works here). In dev with no password the page
  opens freely until the first key exists — mint that first key with `admin` scope (or set a
  password) so you don't lock yourself out of the page.
- Scope the `/admin` route to a trusted operator origin at deploy time; it is a key-minting
  console, not a public page.

## Connecting a coding agent (MCP over HTTP)

Bearer auth on the streamable-HTTP endpoint. Header-capable clients (Claude Code, VS Code,
Cursor, raw SDK) all support this:

```bash
claude mcp add --transport http eddysearch \
  https://agenticsearch.eduard-bruell.de/mcp \
  --header "Authorization: Bearer esk_your_key_here"
```

The key needs the `mcp` scope (and `lit_search` to use the fat `lit_search` tool). The cheap
tools (`find_papers`, `keyword_search`, `find_people`, `verify_references`, `corpus_context`)
need only `mcp`.

- **REST clients** send `Authorization: Bearer <key>` or `x-api-key: <key>`.
- **Local stdio** (`npm run start:mcp-stdio`) bypasses auth — shell access *is* the key.
- **claude.ai / ChatGPT connectors** can't send custom headers; OAuth 2.1 for those is
  deferred (PLAN.md §11 decision 2). Use a coding-agent client for now.
