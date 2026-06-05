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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
