import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ status: "ok", service: "agentic_backend" }));

serve({ fetch: app.fetch, port: 8001 }, (info) => {
  console.log(`agentic_backend listening on http://localhost:${info.port}`);
});
