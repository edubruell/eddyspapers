import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.js";

const server = buildMcpServer(null);
const [c, s] = InMemoryTransport.createLinkedPair();
await server.connect(s);
const client = new Client({ name: "dump", version: "1" });
await client.connect(c);
const { tools } = await client.listTools();
const t = tools.find((x) => x.name === "verify_references")!;
console.log("=== DESCRIPTION ===\n" + t.description);
console.log("\n=== INPUT SCHEMA ===\n" + JSON.stringify(t.inputSchema, null, 2));
process.exit(0);
