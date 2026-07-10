import { Hono } from "hono";
import { cors } from "hono/cors";
import { chatRoute } from "./routes/chat.js";
import { streamRoute } from "./routes/stream.js";
import { searchesRoute } from "./routes/searches.js";
import { statsRoute } from "./routes/stats.js";
import { exportRoute } from "./routes/export.js";
import { papersRoute } from "./routes/papers.js";
import { corpusRoute } from "./routes/corpus.js";
import { requireAuth } from "./middleware/auth.js";

// App construction is separate from serving (index.ts) so route tests can drive
// it through app.request() without binding a port.
export function buildApp(): Hono {
  const app = new Hono();

  // Dev: allow the Astro frontend (separate origin) to call the API + read the SSE stream.
  const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:4321,http://localhost:4322")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use("*", cors({ origin: corsOrigins }));

  app.get("/healthz", (c) => c.json({ status: "ok", service: "agentic_backend" }));
  // Login probe: 200 when the presented password is valid (or the gate is disabled),
  // 401 otherwise. The frontend gate uses this to decide whether to show the lock screen.
  app.get("/auth/check", requireAuth, (c) => c.json({ ok: true }));
  app.route("/chat", chatRoute);
  app.route("/chat", streamRoute);
  app.route("/searches", searchesRoute);
  app.route("/stats", statsRoute);
  app.route("/export", exportRoute);
  app.route("/papers", papersRoute);
  app.route("/corpus", corpusRoute);

  return app;
}
