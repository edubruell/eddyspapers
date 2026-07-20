/*
 * API-key management CLI (PLAN.md §D1).
 *
 * A thin HTTP client for the running server's /admin/keys routes — the server is the only
 * process that opens appdata.duckdb (DuckDB's file lock is exclusive), so keys are minted,
 * listed, and revoked through it rather than by opening the DB directly.
 *
 *   npm run keys -- new  "Alice (ZEW)" --scopes rest,mcp,lit_search
 *   npm run keys -- list [--all]
 *   npm run keys -- revoke <id-or-hash-prefix>
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

async function cmdNew(args: string[]): Promise<void> {
  const label = args.find((a) => !a.startsWith("--"));
  if (!label) die('Usage: keys new "<label>" [--scopes rest,mcp,lit_search,admin]');
  const scopesFlag = getFlag(args, "scopes");
  const scopes = scopesFlag ? scopesFlag.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const data = (await req("POST", "/admin/keys", { label, scopes })) as {
    key: string;
    id: string;
    scopes: string[];
  };
  process.stdout.write(
    `Created key ${data.id} [${data.scopes.join(", ")}] for "${label}".\n\n` +
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

async function cmdList(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const data = (await req("GET", `/admin/keys${all ? "?all=1" : ""}`)) as {
    keys: {
      id: string;
      label: string;
      scopes: string[];
      rate_limit_overrides: Record<string, number> | null;
      created_at: string;
      revoked_at: string | null;
    }[];
  };
  if (data.keys.length === 0) {
    process.stdout.write("No keys.\n");
    return;
  }
  for (const k of data.keys) {
    const state = k.revoked_at ? `revoked ${k.revoked_at}` : "active";
    const over = k.rate_limit_overrides ? `  overrides=${JSON.stringify(k.rate_limit_overrides)}` : "";
    process.stdout.write(`${k.id}  [${k.scopes.join(",")}]  ${state}  ${k.label}${over}\n`);
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
    default:
      die("Usage: keys <new|list|revoke> …");
  }
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
