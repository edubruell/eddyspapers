import type { AppDataDb } from "./appdata.js";

// MCP usage log + the admin stats over it and the self-serve signups. Only the JSON-RPC
// method, the tool name and the outcome are stored: never arguments, which carry the
// caller's research questions.

type JsonRpc = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown };
  result?: { isError?: unknown; _meta?: { refused?: unknown } };
  error?: unknown;
};

// "refused": a scope or rate-limit refusal (the tool sets _meta.refused), counted apart from
// tool errors so a client retrying into the concurrency cap does not read as a broken tool.
export type McpOutcome = "ok" | "refused" | "tool_error" | "rpc_error" | "no_reply";

export interface McpCallRow {
  keyId: string;
  method: string;
  tool: string | null;
  outcome: McpOutcome;
  ms: number;
}

const asMessages = (body: unknown): JsonRpc[] =>
  (Array.isArray(body) ? body : [body]).filter(
    (m): m is JsonRpc => m != null && typeof m === "object",
  );

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const outcomeOf = (reply: JsonRpc | undefined): McpOutcome =>
  reply == null
    ? "no_reply"
    : reply.error != null
      ? "rpc_error"
      : reply.result?.isError === true
        ? reply.result._meta?.refused != null
          ? "refused"
          : "tool_error"
        : "ok";

// Pairs each request (a message with an id; notifications are skipped) with its reply by
// id. Pure, so the hook in mcp/server.ts stays a one-liner and the pairing is testable.
export const mcpCallRows = (
  keyId: string,
  requestText: string,
  replyText: string,
  ms: number,
): McpCallRow[] => {
  const replies = asMessages(parseJson(replyText));
  // The SDK refuses a whole request (bad Accept, content type, protocol version) with one
  // error whose id is null; that reply answers every message in it.
  const refusal = replies.find((r) => r.id == null && r.error != null);
  return asMessages(parseJson(requestText))
    .filter((m) => m.id != null && typeof m.method === "string")
    .map((m) => ({
      keyId,
      method: String(m.method),
      tool: m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name : null,
      outcome: refusal ? "rpc_error" : outcomeOf(replies.find((r) => r.id === m.id)),
      ms: Math.round(ms),
    }));
};

export async function logMcpCalls(db: AppDataDb, rows: McpCallRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.run(
    `INSERT INTO mcp_call_log (key_id, method, tool, outcome, ms) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    rows.flatMap((r) => [r.keyId, r.method, r.tool, r.outcome, r.ms]),
  );
}

export interface McpStats {
  days: number;
  signups: { total_live: number; in_window: number };
  daily: {
    day: string;
    signups: number;
    requests: number;
    tool_calls: number;
    active_keys: number;
    lit_search_calls: number;
  }[];
  tools: {
    tool: string;
    calls: number;
    errors: number;
    refused: number;
    keys: number;
    avg_ms: number | null;
    median_ms: number | null;
  }[];
}

const num = (v: unknown): number => Number(v ?? 0);

// One row per person who got a key mailed: a resend rotates the key (new row, old one
// revoked), a failed send never sets verified_at, and the self-service revoke nulls email
// but keeps the label, so people are counted by label from their first verified key.
const SIGNUP_PEOPLE = `SELECT label, MIN(created_at) AS first_at, bool_or(revoked_at IS NULL) AS live
  FROM api_keys WHERE label LIKE 'signup:%' AND verified_at IS NOT NULL GROUP BY label`;

export async function getMcpStats(db: AppDataDb, days: number): Promise<McpStats> {
  const since = "now() - to_days(CAST(? AS INTEGER))";
  const [signups] = await db.query(
    `SELECT COUNT(*) FILTER (WHERE live) AS total_live,
            COUNT(*) FILTER (WHERE first_at >= ${since}) AS in_window
     FROM (${SIGNUP_PEOPLE})`,
    [days],
  );
  const daily = await db.query(
    `WITH calls AS (
       SELECT CAST(ts AS DATE) AS day,
              COUNT(*) AS requests,
              COUNT(*) FILTER (WHERE method = 'tools/call') AS tool_calls,
              COUNT(DISTINCT key_id) AS active_keys,
              COUNT(*) FILTER (WHERE tool = 'lit_search') AS lit_search_calls
       FROM mcp_call_log WHERE ts >= ${since} GROUP BY 1
     ),
     signups AS (
       SELECT CAST(first_at AS DATE) AS day, COUNT(*) AS signups
       FROM (${SIGNUP_PEOPLE}) WHERE first_at >= ${since} GROUP BY 1
     )
     SELECT COALESCE(c.day, s.day) AS day, COALESCE(s.signups, 0) AS signups,
            COALESCE(c.requests, 0) AS requests, COALESCE(c.tool_calls, 0) AS tool_calls,
            COALESCE(c.active_keys, 0) AS active_keys, COALESCE(c.lit_search_calls, 0) AS lit_search_calls
     FROM calls c FULL JOIN signups s ON c.day = s.day
     ORDER BY 1`,
    [days, days],
  );
  const tools = await db.query(
    `SELECT tool, COUNT(*) AS calls,
            COUNT(*) FILTER (WHERE outcome NOT IN ('ok', 'refused')) AS errors,
            COUNT(*) FILTER (WHERE outcome = 'refused') AS refused,
            COUNT(DISTINCT key_id) AS keys,
            AVG(ms) FILTER (WHERE outcome <> 'refused') AS avg_ms,
            MEDIAN(ms) FILTER (WHERE outcome <> 'refused') AS median_ms
     FROM mcp_call_log
     WHERE ts >= ${since} AND tool IS NOT NULL
     GROUP BY tool ORDER BY calls DESC, tool`,
    [days],
  );
  return {
    days,
    signups: { total_live: num(signups?.total_live), in_window: num(signups?.in_window) },
    daily: daily.map((r) => ({
      day: String(r.day),
      signups: num(r.signups),
      requests: num(r.requests),
      tool_calls: num(r.tool_calls),
      active_keys: num(r.active_keys),
      lit_search_calls: num(r.lit_search_calls),
    })),
    tools: tools.map((r) => ({
      tool: String(r.tool),
      calls: num(r.calls),
      errors: num(r.errors),
      refused: num(r.refused),
      keys: num(r.keys),
      avg_ms: r.avg_ms == null ? null : Math.round(Number(r.avg_ms)),
      median_ms: r.median_ms == null ? null : Math.round(Number(r.median_ms)),
    })),
  };
}
