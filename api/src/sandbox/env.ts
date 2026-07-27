// The sandbox R subprocess inherits the API service's environment by default,
// which holds secrets (OPENROUTER_API_KEY, AGENTIC_PASSWORD, appdata/DB creds).
// An allowlisted sandbox script can exfiltrate them via `emit_note(Sys.getenv(...))`,
// so we pass the child only the variables R needs to locate its libraries, run, and
// reach the local Ollama embedder — never the parent environment wholesale.
const ALLOW_EXACT = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "LANG",
  "R_HOME",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
]);

const ALLOW_PREFIX = ["LC_", "R_LIBS", "OLLAMA_"];

export function sandboxEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ALLOW_EXACT.has(k) || ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
