import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";

serve({ fetch: buildApp().fetch, port: 8001 }, (info) => {
  console.log(`eddyspapers-api listening on http://localhost:${info.port}`);
});
