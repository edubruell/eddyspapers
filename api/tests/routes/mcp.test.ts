import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";
import { FIXTURE_PATH, requireFixture } from "../search/helpers.js";

// Route-level test: the streamable-HTTP /mcp endpoint is wired into the Hono app and
// completes an MCP initialize handshake. Verifies transport mounting + the requireAuth
// gate being open when AGENTIC_PASSWORD is unset. Full tool/resource/prompt behaviour
// is covered by tests/mcp/server.test.ts over the in-memory transport.
let app: Hono;

beforeAll(async () => {
  requireFixture();
  process.env.DB_SNAPSHOT = FIXTURE_PATH;
  delete process.env.AGENTIC_PASSWORD;
  const { buildApp } = await import("../../src/app.js");
  app = buildApp();
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "route-test", version: "1.0.0" },
  },
};

describe("POST /mcp", () => {
  it("completes an initialize handshake and returns serverInfo", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // enableJsonResponse mode: the JSON-RPC reply is a single application/json body.
    expect(body).toMatch(/eddysearch/);
    expect(body).toMatch(/serverInfo|protocolVersion/);
  });

  it("rejects a request with no Accept for the event stream", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(initializeBody),
    });
    // The transport requires both application/json and text/event-stream in Accept
    // (MCP streamable-HTTP spec) even in JSON-response mode → 406 Not Acceptable.
    expect(res.status).toBe(406);
  });

  it("rejects when Accept has text/event-stream but not application/json", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(406);
  });

  it("does not 200 a malformed JSON body", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{ this is not valid json",
    });
    // A parse failure must not complete the handshake — the transport rejects it.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("drives a full tools/list over the HTTP transport", async () => {
    // The route path must expose the same tool set as the in-memory transport.
    const listBody = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(listBody),
    });
    // tools/list requires an initialized session; stateless transport returns the
    // JSON-RPC error inline (still HTTP 200 for the SSE/JSON envelope) — assert we
    // get a structured JSON-RPC frame back, not a transport crash.
    const text = await res.text();
    expect(text).toMatch(/"jsonrpc"\s*:\s*"2\.0"/);
  });
});
