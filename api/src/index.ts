import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { env } from "./env.js";

// A run id doubles as the share-link token for the ungated /searches/:id and SSE endpoints
// (08_sharelinks.md), so it must be an HMAC under a secret no user holds. Refuse to serve a
// deployment that authenticates callers but has no dedicated secret, rather than silently
// keying run ids with something the callers themselves know.
if (env.AGENTIC_PASSWORD !== "" && env.SEARCH_ID_SECRET === "") {
  console.error(
    "SEARCH_ID_SECRET is not set. Generate one (openssl rand -base64 32) and put it in the " +
      "service env; it must stay stable across restarts.",
  );
  process.exit(1);
}

serve({ fetch: buildApp().fetch, port: 8001 }, (info) => {
  console.log(`eddyspapers-api listening on http://localhost:${info.port}`);
});
