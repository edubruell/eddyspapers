import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chatRoute } from "./routes/chat.js";
import { streamRoute } from "./routes/stream.js";
import { searchesRoute } from "./routes/searches.js";

const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok", service: "agentic_backend" }));
app.route("/chat", chatRoute);
app.route("/chat", streamRoute);
app.route("/searches", searchesRoute);

serve({ fetch: app.fetch, port: 8001 }, (info) => {
  console.log(`agentic_backend listening on http://localhost:${info.port}`);
});
