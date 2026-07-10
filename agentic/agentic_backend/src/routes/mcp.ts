import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { handleMcpRequest } from "../mcp/server.js";

// Streamable-HTTP MCP endpoint (01_design.md §7.1, PLAN.md §C). Bearer / x-agentic-key
// auth via the shared requireAuth gate for now; Phase 4 swaps in scoped API keys
// (requireKey('mcp')). Stateless: each GET/POST/DELETE gets its own server+transport
// (handleMcpRequest), so no session bookkeeping.

export const mcpRoute = new Hono();

// Wildcard so both /mcp and /mcp/ reach the handler — some MCP clients normalise
// the endpoint to a trailing slash.
mcpRoute.all("*", requireAuth, (c) => handleMcpRequest(c.req.raw));
