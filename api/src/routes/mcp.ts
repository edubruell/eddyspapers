import { Hono } from "hono";
import { requireKey, getApiKey } from "../middleware/requireKey.js";
import { handleMcpRequest } from "../mcp/server.js";

// Streamable-HTTP MCP endpoint (01_design.md §7.1, PLAN.md §C). Gated by an 'mcp'-scoped
// API key (Bearer / x-api-key); the resolved identity is threaded into the per-request
// server so lit_search can enforce its own 'lit_search' scope + per-key rate limits.
// Stateless: each GET/POST/DELETE gets its own server+transport (handleMcpRequest), so no
// session bookkeeping.

export const mcpRoute = new Hono();

// Wildcard so both /mcp and /mcp/ reach the handler — some MCP clients normalise
// the endpoint to a trailing slash.
// No standalone SSE stream: in stateless mode the SDK answers GET with a stream that never
// closes, which the buffered handler would wait on forever. The spec allows 405 here.
mcpRoute.get("*", (c) => c.body(null, 405, { Allow: "POST, DELETE" }));
mcpRoute.all("*", requireKey("mcp"), (c) => handleMcpRequest(c.req.raw, getApiKey(c)));
