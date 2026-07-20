// Hermetic mock of the agentic backend for Playwright e2e: serves POST /chat
// and replays a recorded SSE event fixture on GET /chat/:id/stream. No LLM/DB.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = process.env.MOCK_FIXTURE ?? "run-minwage.jsonl";
const events = readFileSync(join(__dirname, "fixtures", FIXTURE), "utf-8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

const PORT = Number(process.env.MOCK_PORT ?? 8011);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID, Authorization");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory API-key registry for the /admin e2e. A gate is simulated: any request without a
// Bearer token is 401 (mirrors requireKey('admin') on an enabled registry). Not persisted.
const ADMIN_SCOPES = ["rest", "mcp", "lit_search", "admin"];
let adminKeys = [];
let adminSeq = 0;
const hasToken = (req) => (req.headers["authorization"] ?? "").startsWith("Bearer ");
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mock" }));
    return;
  }

  // Gate probes this on mount; the mock backend is open (no password), so it
  // always passes — letting the landing app render instead of the lock screen.
  if (req.method === "GET" && url.pathname === "/auth/check") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /admin/keys registry (mirrors the backend wire shapes) ──────────────────
  if (url.pathname === "/admin/keys" || url.pathname.startsWith("/admin/keys/")) {
    if (!hasToken(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/keys") {
      const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
      const keys = all ? adminKeys : adminKeys.filter((k) => !k.revoked_at);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ scopes: ADMIN_SCOPES, keys }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/keys") {
      const body = await readBody(req);
      const id = `mockid${(adminSeq += 1)}`.padEnd(12, "0").slice(0, 12);
      const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ["rest", "mcp"];
      adminKeys = [
        ...adminKeys,
        {
          id,
          label: body.label,
          scopes,
          rate_limit_overrides: null,
          created_at: "2026-07-11T00:00:00",
          revoked_at: null,
        },
      ];
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key: `esk_mock_${id}_plaintext`, key_hash: id + "…", id, label: body.label, scopes }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/admin/keys/")) {
      const prefix = decodeURIComponent(url.pathname.slice("/admin/keys/".length));
      let revoked = 0;
      adminKeys = adminKeys.map((k) => {
        if (!k.revoked_at && k.id.startsWith(prefix)) {
          revoked += 1;
          return { ...k, revoked_at: "2026-07-11T01:00:00" };
        }
        return k;
      });
      res.writeHead(revoked ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(revoked ? { revoked } : { error: "No active key matched that prefix" }));
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "mock-run" }));
    return;
  }

  if (req.method === "GET" && /^\/chat\/[^/]+\/stream$/.test(url.pathname)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const line of events) {
      let seq = 0;
      try {
        seq = JSON.parse(line).seq ?? 0;
      } catch {
        /* keep 0 */
      }
      res.write(`id: ${seq}\ndata: ${line}\n\n`);
      // Stagger so the stepper/strategy transitions are observable but fast.
      const evt = (() => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      })();
      if (evt.type === "synthesis") await sleep(1);
      else await sleep(8);
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`mock agentic backend on http://localhost:${PORT} (fixture: ${FIXTURE}, ${events.length} events)`);
});
