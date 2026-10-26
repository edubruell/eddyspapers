import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "./tools.js";
import { registerLitSearch } from "./litSearch.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import type { KeyIdentity } from "../auth/keys.js";
import { getAppDataDb } from "../db/singleton.js";
import { logMcpCalls, mcpCallRows } from "../db/mcpLog.js";

// One agent core, two faces (01_design.md §7.1): the same tool/resource/prompt
// registrations feed both the hosted streamable-HTTP transport (this file) and the
// local stdio binary (mcp-stdio.ts). Business logic lives in src/search/* service
// functions — this layer is pure transport wiring.
//
// `key` is the authenticated API-key identity (null when the gate is disabled or for the
// keyless local stdio build). It rides into the tool registrations so per-key rate limits
// and the finer 'lit_search' scope can be enforced at call time.

export function buildMcpServer(key: KeyIdentity | null = null): McpServer {
  const server = new McpServer(
    { name: "eddysearch", version: "0.2.0" },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerTools(server, key);
  registerLitSearch(server, key);
  registerResources(server, key);
  registerPrompts(server);
  return server;
}

// Stateless streamable HTTP: a fresh server+transport per request. The SDK's
// stateless web-standard transport refuses reuse ("cannot be reused across
// requests"), so there is no long-lived singleton — registration is cheap (all the
// heavy state, the DuckDB pool, is a shared singleton behind getCorpusDb()).
// enableJsonResponse buffers each JSON-RPC reply into one Response instead of an
// SSE stream, which lets us tear the transport down deterministically once the body
// is read. lit_search emits progress notifications during the call (§7.4); in this
// buffered JSON mode they are collected and returned with the reply rather than
// streamed live — stdio and any future SSE-mode path deliver them incrementally. Auth
// is handled upstream by the Hono route.
const parseOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export async function handleMcpRequest(req: Request, key: KeyIdentity | null = null): Promise<Response> {
  const server = buildMcpServer(key);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const started = performance.now();
  try {
    // Read the body once for the call log and hand it to the SDK parsed; text that is
    // not JSON goes through as undefined and gets the SDK's own 400 parse error.
    const requestText = key && req.method === "POST" ? await req.text() : "";
    const res = await (key && req.method === "POST"
      ? transport.handleRequest(req, { parsedBody: parseOrUndefined(requestText) })
      : transport.handleRequest(req));
    // Buffer the (finite, JSON) body before closing so teardown can't truncate it.
    const body = await res.arrayBuffer();
    if (key) {
      const replyText = new TextDecoder().decode(body);
      const ms = performance.now() - started;
      // Usage logging must never cost the caller a reply.
      void Promise.resolve()
        .then(async () => logMcpCalls(await getAppDataDb(), mcpCallRows(key.id, requestText, replyText, ms)))
        .catch((err: unknown) => console.error("[mcp] call log failed:", err));
    }
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    await transport.close();
    await server.close();
  }
}
