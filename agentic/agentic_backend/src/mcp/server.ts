import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "./tools.js";
import { registerLitSearch } from "./litSearch.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

// One agent core, two faces (01_design.md §7.1): the same tool/resource/prompt
// registrations feed both the hosted streamable-HTTP transport (this file) and the
// local stdio binary (mcp-stdio.ts). Business logic lives in src/search/* service
// functions — this layer is pure transport wiring.

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "eddysearch", version: "0.2.0" },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerTools(server);
  registerLitSearch(server);
  registerResources(server);
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
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    // Buffer the (finite, JSON) body before closing so teardown can't truncate it.
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    await transport.close();
    await server.close();
  }
}
