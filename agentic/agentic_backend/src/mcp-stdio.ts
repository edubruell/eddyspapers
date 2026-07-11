import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp/server.js";

// Local stdio MCP entry point (01_design.md §7.1, built to dist/mcp-stdio.js). A
// coding agent spawns this binary and talks JSON-RPC over stdin/stdout. Auth is
// bypassed — the key here is shell access (§7.9) — and it reads the corpus snapshot
// directly via the shared getCorpusDb() singleton (DB_SNAPSHOT env or default path).
//
// stdout is the JSON-RPC channel: never console.log here — diagnostics go to stderr.

const server = buildMcpServer();
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
  console.error("eddysearch MCP (stdio) ready");
} catch (err) {
  console.error("eddysearch MCP (stdio) failed to start:", err);
  process.exit(1);
}
