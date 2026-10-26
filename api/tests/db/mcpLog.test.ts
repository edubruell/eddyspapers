import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openAppDataDb, type AppDataDb } from "../../src/db/appdata.js";
import { getMcpStats, logMcpCalls, mcpCallRows } from "../../src/db/mcpLog.js";
import { getAppDataDb, resetAppDataDb } from "../../src/db/singleton.js";
import { handleMcpRequest } from "../../src/mcp/server.js";
import type { KeyIdentity } from "../../src/auth/keys.js";

describe("mcpCallRows", () => {
  it("pairs each request with its reply by id and names the tool", () => {
    const rows = mcpCallRows(
      "abc",
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "find_papers", arguments: { query: "secret topic" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
      12.4,
    );
    expect(rows).toEqual([{ keyId: "abc", method: "tools/call", tool: "find_papers", outcome: "ok", ms: 12 }]);
    expect(JSON.stringify(rows)).not.toContain("secret topic");
  });

  it("classifies tool errors, rpc errors and missing replies", () => {
    const req = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lit_search" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
    const reply = JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "unknown tool" } },
    ]);
    expect(mcpCallRows("k", req, reply, 1).map((r) => [r.tool, r.outcome])).toEqual([
      ["lit_search", "tool_error"],
      ["nope", "rpc_error"],
      [null, "no_reply"],
    ]);
  });

  it("skips notifications and survives bodies that are not JSON", () => {
    expect(mcpCallRows("k", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "", 1)).toEqual([]);
    expect(mcpCallRows("k", "not json", "also not", 1)).toEqual([]);
    expect(mcpCallRows("k", "", "", 1)).toEqual([]);
  });
});

describe("getMcpStats", () => {
  let tmp = "";
  let db: AppDataDb;

  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("rolls calls and signups up by day and by tool", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    db = await openAppDataDb();

    await db.createKey({ keyHash: "a".repeat(64), label: "signup:x@uni.example", scopes: ["mcp"], email: "x@uni.example" });
    await db.markKeyVerified("a".repeat(64));
    await db.createKey({ keyHash: "b".repeat(64), label: "operator", scopes: ["mcp"] });
    await logMcpCalls(db, [
      { keyId: "aaaa", method: "initialize", tool: null, outcome: "ok", ms: 3 },
      { keyId: "aaaa", method: "tools/call", tool: "find_papers", outcome: "ok", ms: 100 },
      { keyId: "bbbb", method: "tools/call", tool: "find_papers", outcome: "tool_error", ms: 300 },
      { keyId: "bbbb", method: "tools/call", tool: "lit_search", outcome: "ok", ms: 40000 },
    ]);

    const stats = await getMcpStats(db, 7);
    expect(stats.signups).toEqual({ total_live: 1, in_window: 1 });
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]).toMatchObject({ signups: 1, requests: 4, tool_calls: 3, active_keys: 2, lit_search_calls: 1 });
    expect(stats.tools).toEqual([
      { tool: "find_papers", calls: 2, errors: 1, keys: 2, avg_ms: 200 },
      { tool: "lit_search", calls: 1, errors: 0, keys: 1, avg_ms: 40000 },
    ]);
  });

  it("returns empty rollups on a fresh store", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    db = await openAppDataDb();
    expect(await getMcpStats(db, 30)).toEqual({
      days: 30,
      signups: { total_live: 0, in_window: 0 },
      daily: [],
      tools: [],
    });
  });
});

describe("handleMcpRequest call log", () => {
  const key: KeyIdentity = { id: "feedbeef0001", label: "t", scopes: ["mcp"], rateLimitOverrides: null, tools: null };
  let tmp = "";

  afterEach(async () => {
    await resetAppDataDb();
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const post = (body: unknown, k: KeyIdentity | null) =>
    handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      }),
      k,
    );

  const logged = async () => (await getAppDataDb()).query("SELECT key_id, method, tool, outcome FROM mcp_call_log");

  it("logs a keyed request and leaves the reply intact", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    await resetAppDataDb();

    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, key);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("find_papers");

    await vi.waitFor(async () => expect(await logged()).toHaveLength(1));
    expect(await logged()).toEqual([{ key_id: "feedbeef0001", method: "tools/list", tool: null, outcome: "ok" }]);
  });

  it("logs nothing for a keyless (dev) request", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    await resetAppDataDb();

    await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(await logged()).toEqual([]);
  });
});

describe("mcpCallRows — id matching", () => {
  it("pairs string ids and id 0, and does not cross-match '1' with 1", () => {
    const req = JSON.stringify([
      { jsonrpc: "2.0", id: "a-1", method: "tools/call", params: { name: "find_people" } },
      { jsonrpc: "2.0", id: 0, method: "tools/list" },
      { jsonrpc: "2.0", id: "1", method: "ping" },
    ]);
    const reply = JSON.stringify([
      { jsonrpc: "2.0", id: "a-1", result: { content: [] } },
      { jsonrpc: "2.0", id: 0, error: { code: -32601, message: "nope" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
    expect(mcpCallRows("k", req, reply, 1).map((r) => [r.method, r.outcome])).toEqual([
      ["tools/call", "ok"],
      ["tools/list", "rpc_error"],
      ["ping", "no_reply"],
    ]);
  });

  it("ignores a non-string tool name and non-object params", () => {
    const rows = mcpCallRows(
      "k",
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 42 } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: "x" },
        { jsonrpc: "2.0", id: 3, method: 5 },
      ]),
      "[]",
      1,
    );
    expect(rows.map((r) => [r.method, r.tool])).toEqual([
      ["tools/call", null],
      ["tools/call", null],
    ]);
  });
});

describe("getMcpStats — window and shape", () => {
  let tmp = "";
  let db: AppDataDb;

  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("drops rows older than the window, renders day as YYYY-MM-DD and orders days", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    db = await openAppDataDb();
    await db.run(
      `INSERT INTO mcp_call_log (ts, key_id, method, tool, outcome, ms) VALUES
         (now() - INTERVAL 40 DAY, 'old', 'tools/call', 'find_papers', 'ok', 1),
         (now() - INTERVAL 3 DAY, 'k1', 'tools/call', 'lit_search', 'no_reply', 10),
         (now(), 'k1', 'initialize', NULL, 'ok', 1)`,
    );
    const stats = await getMcpStats(db, 30);
    expect(stats.daily.map((d) => d.day)).toHaveLength(2);
    stats.daily.forEach((d) => expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    expect(stats.daily[0]!.day < stats.daily[1]!.day).toBe(true);
    expect(stats.daily.map((d) => d.requests)).toEqual([1, 1]);
    expect(stats.tools).toEqual([{ tool: "lit_search", calls: 1, errors: 1, keys: 1, avg_ms: 10 }]);
    expect((await getMcpStats(db, 365)).tools.map((t) => t.tool)).toEqual(["find_papers", "lit_search"]);
  });

  it("puts a signup-only day in the daily rollup (FULL JOIN side) and keeps revoked signups out of total_live", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    db = await openAppDataDb();
    await db.createKey({ keyHash: "c".repeat(64), label: "signup:y@uni.example", scopes: ["mcp"], email: "y@uni.example" });
    await db.createKey({ keyHash: "d".repeat(64), label: "signup:z@uni.example", scopes: ["mcp"], email: "z@uni.example" });
    await db.markKeyVerified("c".repeat(64));
    await db.markKeyVerified("d".repeat(64));
    await db.revokeKey("d".repeat(12));
    const stats = await getMcpStats(db, 7);
    expect(stats.signups).toEqual({ total_live: 1, in_window: 2 });
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]).toMatchObject({ signups: 2, requests: 0, tool_calls: 0, active_keys: 0 });
  });

  it("counts a person once across resends, skips unsent keys, and keeps a self-revoked person", async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    db = await openAppDataDb();
    // Resend: the first key is revoked and a second one minted for the same label.
    await db.createKey({ keyHash: "e".repeat(64), label: "signup:r@uni.example", scopes: ["mcp"], email: "r@uni.example" });
    await db.markKeyVerified("e".repeat(64));
    await db.revokeKey("e".repeat(12));
    await db.createKey({ keyHash: "f".repeat(64), label: "signup:r@uni.example", scopes: ["mcp"], email: "r@uni.example" });
    await db.markKeyVerified("f".repeat(64));
    // The mail never went out: no verified_at.
    await db.createKey({ keyHash: "1".repeat(64), label: "signup:fail@uni.example", scopes: ["mcp"], email: "fail@uni.example" });
    // Self-service revoke nulls email but keeps label and verified_at.
    await db.createKey({ keyHash: "2".repeat(64), label: "signup:gone@uni.example", scopes: ["mcp"], email: "gone@uni.example" });
    await db.markKeyVerified("2".repeat(64));
    await db.run("UPDATE api_keys SET email = NULL, revoked_at = now() WHERE key_hash = ?", ["2".repeat(64)]);
    // Operator keys never count.
    await db.createKey({ keyHash: "3".repeat(64), label: "operator", scopes: ["mcp"] });
    await db.markKeyVerified("3".repeat(64));

    const stats = await getMcpStats(db, 7);
    expect(stats.signups).toEqual({ total_live: 1, in_window: 2 });
    expect(stats.daily[0]).toMatchObject({ signups: 2 });
  });
});

describe("handleMcpRequest call log — transport edges", () => {
  const key: KeyIdentity = { id: "feedbeef0002", label: "t", scopes: ["mcp"], rateLimitOverrides: null, tools: null };
  let tmp = "";

  afterEach(async () => {
    await resetAppDataDb();
    vi.unstubAllEnvs();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const fresh = async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentic-mcplog-"));
    vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
    await resetAppDataDb();
  };
  const logged = async () =>
    (await getAppDataDb()).query("SELECT key_id, method, tool, outcome FROM mcp_call_log ORDER BY method");
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("passes a large request body through intact and stores no arguments", async () => {
    await fresh();
    const big = "x".repeat(2_000_000);
    const res = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "no_such_tool", arguments: { q: big } } }),
      }),
      key,
    );
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { id: number };
    expect(reply.id).toBe(9);
    await vi.waitFor(async () => expect(await logged()).toHaveLength(1));
    const [row] = await logged();
    expect(row).toMatchObject({ method: "tools/call", tool: "no_such_tool" });
    expect(row!.outcome).not.toBe("ok");
    expect(JSON.stringify(await logged())).not.toContain("xxxx");
  });

  it("logs nothing for a notification-only POST (202) or a keyed GET", async () => {
    await fresh();
    const note = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      key,
    );
    expect(note.status).toBe(202);
    const get = await handleMcpRequest(
      // Accept without text/event-stream: a real SSE GET never ends in this buffered handler.
      new Request("http://localhost/mcp", { method: "GET", headers: { Accept: "application/json" } }),
      key,
    );
    expect(get.status).toBe(406);
    await settle();
    expect(await logged()).toEqual([]);
  });

  it("logs a transport-level refusal (406) as rpc_error: the error carries id null and answers the whole request", async () => {
    await fresh();
    const res = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      key,
    );
    expect(res.status).toBe(406);
    await vi.waitFor(async () => expect(await logged()).toHaveLength(1));
    expect((await logged())[0]).toMatchObject({ method: "tools/list", outcome: "rpc_error" });
  });

  it("logs nothing (and still answers) for a body that is not JSON", async () => {
    await fresh();
    const res = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: "{not json",
      }),
      key,
    );
    expect(res.status).toBe(400);
    await settle();
    expect(await logged()).toEqual([]);
  });
});
