const URL = "https://agenticsearch.eduard-bruell.de/mcp";

const key = (process.env.EDDYSEARCH_API_KEY ?? "").trim();
if (!key || key.startsWith("${")) {
  console.error("Eddy's Papers search: no API key set. Add the key from your signup email in the extension settings.");
  process.exit(1);
}
process.env.EDDYSEARCH_AUTH = `Bearer ${key}`;

// Without this check a rejected key sends mcp-remote into an OAuth flow that
// this server does not offer, and it dies with an unrelated JSON parse error.
const probe = await fetch(URL, {
  method: "POST",
  headers: {
    Authorization: process.env.EDDYSEARCH_AUTH,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
  signal: AbortSignal.timeout(15000),
}).catch((e) => ({ status: 0, error: e }));

if (probe.status === 401 || probe.status === 403) {
  console.error("Eddy's Papers search: the server did not accept this API key. Check the key from your signup email in the extension settings.");
  process.exit(1);
}
if (probe.status === 0) {
  console.error(`Eddy's Papers search: cannot reach ${URL} (${probe.error?.message ?? "network error"}).`);
  process.exit(1);
}

// mcp-remote reads its options from argv and expands ${VAR} in headers itself,
// so the key stays out of the process arguments. A short auth timeout stops a
// rejected key from waiting on a browser sign-in this server does not offer.
process.argv = [
  process.argv[0],
  "mcp-remote",
  URL,
  "--transport", "http-only",
  "--header", "Authorization:${EDDYSEARCH_AUTH}",
  "--auth-timeout", "5",
  "--silent",
];

await import("mcp-remote/dist/proxy.js");
