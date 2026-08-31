/*
 * API-key management CLI (PLAN.md §D1).
 *
 * A thin HTTP client for the running server's /admin/keys routes — the server is the only
 * process that opens appdata.duckdb (DuckDB's file lock is exclusive), so keys are minted,
 * listed, and revoked through it rather than by opening the DB directly.
 *
 *   npm run keys -- new  "Alice (ZEW)" --scopes rest,mcp,lit_search [--tools find_papers,keyword_search]
 *   npm run keys -- list [--all]
 *   npm run keys -- revoke <id-or-hash-prefix>
 *   npm run keys -- scopes <id-or-hash-prefix> --scopes rest,mcp,lit_search,lit_search_synth
 *   npm run keys -- grant  <scope> [--all | <id-or-hash-prefix> ...]
 *
 * Config via env:
 *   AGENTIC_API_BASE     server base URL          (default http://127.0.0.1:8001)
 *   AGENTIC_ADMIN_TOKEN  admin-scoped key/password (falls back to AGENTIC_PASSWORD)
 *
 * The minted plaintext key is printed ONCE — it is never stored and cannot be recovered.
 */

const base = (process.env.AGENTIC_API_BASE ?? "http://127.0.0.1:8001").replace(/\/$/, "");
const token = process.env.AGENTIC_ADMIN_TOKEN ?? process.env.AGENTIC_PASSWORD ?? "";

const authHeaders = (): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    die(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const csvFlag = (args: string[], name: string): string[] | undefined => {
  const raw = getFlag(args, name);
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
};

async function cmdNew(args: string[]): Promise<void> {
  const label = args.find((a) => !a.startsWith("--"));
  if (!label)
    die('Usage: keys new "<label>" [--scopes rest,mcp,lit_search,admin] [--tools find_papers,keyword_search,...]');
  const scopes = csvFlag(args, "scopes");
  // --tools omitted → all MCP tools (server stores null); --tools with a list → allowlist.
  const tools = csvFlag(args, "tools");
  const data = (await req("POST", "/admin/keys", { label, scopes, tools })) as {
    key: string;
    id: string;
    scopes: string[];
    tools: string[] | null;
  };
  // null = all tools (no marker); an array (incl. []) = an explicit allowlist.
  const toolsNote = Array.isArray(data.tools)
    ? `  tools=[${data.tools.length ? data.tools.join(", ") : "none"}]`
    : "";
  process.stdout.write(
    `Created key ${data.id} [${data.scopes.join(", ")}]${toolsNote} for "${label}".\n\n` +
      `  ${data.key}\n\n` +
      `Store it now — it is not recoverable.\n`,
  );
}

async function cmdRevoke(args: string[]): Promise<void> {
  const prefix = args.find((a) => !a.startsWith("--"));
  if (!prefix) die("Usage: keys revoke <id-or-hash-prefix>");
  const data = (await req("DELETE", `/admin/keys/${encodeURIComponent(prefix)}`)) as { revoked: number };
  process.stdout.write(`Revoked ${data.revoked} key(s) matching "${prefix}".\n`);
}

interface KeyRow {
  id: string;
  label: string;
  scopes: string[];
  rate_limit_overrides: Record<string, number> | null;
  tools: string[] | null;
  created_at: string;
  revoked_at: string | null;
}

const fetchKeys = async (all = false): Promise<KeyRow[]> =>
  ((await req("GET", `/admin/keys${all ? "?all=1" : ""}`)) as { keys: KeyRow[] }).keys;

const putScopes = async (id: string, scopes: string[]): Promise<void> => {
  await req("PATCH", `/admin/keys/${encodeURIComponent(id)}`, { scopes });
  process.stdout.write(`${id}  [${scopes.join(",")}]\n`);
};

// Replaces the scope set outright — the caller states the full intended set.
async function cmdScopes(args: string[]): Promise<void> {
  const prefix = args.find((a) => !a.startsWith("--"));
  const scopes = csvFlag(args, "scopes");
  if (!prefix || !scopes?.length) die("Usage: keys scopes <id-or-hash-prefix> --scopes rest,mcp,…");
  await putScopes(prefix, scopes);
}

// ADDS one scope to keys that lack it, leaving their other grants alone — the safe shape for
// rolling out a newly-introduced scope to people who already hold a key.
async function cmdGrant(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const scope = positional[0];
  const targets = positional.slice(1);
  const all = args.includes("--all");
  if (!scope || (!all && targets.length === 0)) die("Usage: keys grant <scope> [--all | <id-or-hash-prefix> ...]");

  const keys = (await fetchKeys()).filter((k) => (all ? true : targets.some((t) => k.id.startsWith(t))));
  const needing = keys.filter((k) => !k.scopes.includes(scope));
  if (needing.length === 0) {
    process.stdout.write(`No active keys need '${scope}' (${keys.length} checked).\n`);
    return;
  }
  for (const k of needing) await putScopes(k.id, [...k.scopes, scope]);
  process.stdout.write(`Granted '${scope}' to ${needing.length} of ${keys.length} active key(s).\n`);
}

async function cmdList(args: string[]): Promise<void> {
  const keys = await fetchKeys(args.includes("--all"));
  if (keys.length === 0) {
    process.stdout.write("No keys.\n");
    return;
  }
  for (const k of keys) {
    const state = k.revoked_at ? `revoked ${k.revoked_at}` : "active";
    const over = k.rate_limit_overrides ? `  overrides=${JSON.stringify(k.rate_limit_overrides)}` : "";
    // null tools = all MCP tools (no marker); a list (incl. []) = the allowlist.
    const tools = Array.isArray(k.tools) ? `  tools=[${k.tools.length ? k.tools.join(",") : "none"}]` : "";
    process.stdout.write(`${k.id}  [${k.scopes.join(",")}]  ${state}  ${k.label}${over}${tools}\n`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "new":
      return cmdNew(args);
    case "revoke":
      return cmdRevoke(args);
    case "list":
      return cmdList(args);
    case "scopes":
      return cmdScopes(args);
    case "grant":
      return cmdGrant(args);
    default:
      die("Usage: keys <new|list|revoke|scopes|grant> …");
  }
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
