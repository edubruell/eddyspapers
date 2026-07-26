import { useState, useEffect, useCallback } from "react";
import {
  getAdminKey,
  setAdminKey,
  listAdminKeys,
  createAdminKey,
  revokeAdminKey,
} from "../../lib/api.js";
import LogoAgentic from "../logo/LogoAgentic.jsx";
import { Card, SectionLabel, PrimaryButton, GhostButton } from "../primitives/index.jsx";

// Operator console for the scoped API-key registry (backend /admin/keys, requireKey('admin')).
// Pure frontend over the three existing admin routes — no new backend surface. The label is
// free text, so the operator writes whom the key was handed to and reads it back here.
//
// Two hard rules mirror the backend: the minted plaintext is shown exactly once (never
// recoverable), and the admin token is stored apart from the search-app key.

const DEFAULT_SCOPES = ["rest", "mcp"];
// Fallback if the list response predates the `scopes` field; the backend echoes ALL_SCOPES.
const FALLBACK_SCOPES = ["rest", "mcp", "lit_search", "admin"];
// Fallback MCP tool list if the response predates `available_tools`; the backend echoes it.
const FALLBACK_TOOLS = ["find_papers", "keyword_search", "find_people", "verify_references", "corpus_context"];

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 16).replace("T", " ");
}

export default function KeyAdmin() {
  const [status, setStatus] = useState("checking"); // checking | locked | open
  const [tokenInput, setTokenInput] = useState("");
  const [lockError, setLockError] = useState(null);

  const [allScopes, setAllScopes] = useState(FALLBACK_SCOPES);
  const [allTools, setAllTools] = useState(FALLBACK_TOOLS);
  const [keys, setKeys] = useState([]);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [listError, setListError] = useState(null);
  const [loading, setLoading] = useState(false);

  // New-key form
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [tools, setTools] = useState(FALLBACK_TOOLS); // selected MCP tools; all = send null
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState(null);

  const [minted, setMinted] = useState(null); // { key, id, label, scopes } shown once
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null); // key id awaiting confirm

  function applyList(data) {
    if (Array.isArray(data.scopes) && data.scopes.length) setAllScopes(data.scopes);
    if (Array.isArray(data.available_tools) && data.available_tools.length) setAllTools(data.available_tools);
    setKeys(data.keys ?? []);
  }

  // A mutation (mint/revoke) that 401/403s means the admin token was revoked mid-session —
  // drop straight to the lock screen rather than showing a raw error over a stale table.
  const isAuthError = (err) => err.status === 401 || err.status === 403;

  const refresh = useCallback(
    async (all = includeRevoked, { signal } = {}) => {
      setLoading(true);
      setListError(null);
      try {
        const data = await listAdminKeys({ all, signal });
        applyList(data);
        setStatus("open");
        return true;
      } catch (err) {
        if (err.name === "AbortError") return false;
        if (isAuthError(err)) setStatus("locked");
        else setListError(err.message);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [includeRevoked],
  );

  useEffect(() => {
    const controller = new AbortController();
    refresh(includeRevoked, { signal: controller.signal });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeRevoked]);

  async function onUnlock(e) {
    e.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate) return;
    setLockError(null);
    try {
      // The probe doubles as the initial fetch — populate the table from its result rather
      // than firing a second list request.
      const data = await listAdminKeys({ token: candidate, all: includeRevoked });
      setAdminKey(candidate);
      applyList(data);
      setStatus("open");
      setTokenInput("");
    } catch (err) {
      setLockError(isAuthError(err) ? "Not an admin key." : err.message);
    }
  }

  // Seed the form to all-selected only when the *content* of available_tools changes (not on
  // every refresh — applyList hands a fresh array each fetch). Keying on the joined names means
  // toggling "Show revoked" mid-edit no longer clobbers a partial tool selection.
  const allToolsKey = allTools.join(",");
  useEffect(() => {
    setTools(allTools);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allToolsKey]);

  function toggleScope(s) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  function toggleTool(t) {
    setTools((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  async function onCreate(e) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || !scopes.length) return;
    setCreating(true);
    setFormError(null);
    try {
      // Tools only matter with the mcp scope. All-selected (or no mcp) → undefined, which the
      // backend stores as null = every tool (and forward-compatibly picks up tools added later).
      const mcpOn = scopes.includes("mcp");
      const allSelected = tools.length === allTools.length && allTools.every((t) => tools.includes(t));
      const toolsPayload = !mcpOn || allSelected ? undefined : tools;
      const res = await createAdminKey({ label: trimmed, scopes, tools: toolsPayload });
      setMinted(res);
      setCopied(false);
      setLabel("");
      setScopes(DEFAULT_SCOPES);
      setTools(allTools);
      refresh();
    } catch (err) {
      if (isAuthError(err)) setStatus("locked");
      else setFormError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id) {
    setConfirmRevoke(null);
    try {
      await revokeAdminKey(id);
      refresh();
    } catch (err) {
      if (isAuthError(err)) setStatus("locked");
      else setListError(err.message);
    }
  }

  async function copyMinted() {
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
    } catch {
      /* clipboard blocked — the key is on screen for manual copy */
    }
  }

  function signOut() {
    setAdminKey("");
    setStatus("locked");
    setKeys([]);
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-stone-500">
        Loading…
      </div>
    );
  }

  if (status === "locked") {
    return (
      <div className="mx-auto flex max-w-[420px] flex-col items-center gap-6 pt-16">
        <LogoAgentic />
        <form
          onSubmit={onUnlock}
          className="w-full rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-5 shadow-sm"
        >
          <label htmlFor="admin-token" className="block text-sm font-medium text-stone-700">
            Key administration
          </label>
          <p className="mt-1 text-[13px] text-stone-500">
            Enter an admin-scoped API key to manage keys.
          </p>
          <input
            id="admin-token"
            type="password"
            autoFocus
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="esk_… or admin password"
            className="mt-3 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
          />
          {lockError && <p className="mt-2 text-sm text-red-600">{lockError}</p>}
          <div className="mt-4">
            <PrimaryButton type="submit" disabled={!tokenInput.trim()}>
              Enter
            </PrimaryButton>
          </div>
        </form>
      </div>
    );
  }

  const activeCount = keys.filter((k) => !k.revoked_at).length;

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-5 pt-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LogoAgentic />
          <div>
            <h1 className="text-lg font-semibold text-stone-800">API keys</h1>
            <p className="text-[13px] text-stone-500">
              {activeCount} active{includeRevoked ? ` · ${keys.length - activeCount} revoked` : ""}
            </p>
          </div>
        </div>
        <GhostButton onClick={signOut} title="Forget the stored admin token">
          Sign out
        </GhostButton>
      </header>

      {/* Mint */}
      <Card className="p-5">
        <SectionLabel>New key</SectionLabel>
        <form onSubmit={onCreate} className="mt-3 flex flex-col gap-3">
          <div>
            <label htmlFor="new-label" className="block text-[13px] font-medium text-stone-700">
              Label — who is this for?
            </label>
            <input
              id="new-label"
              type="text"
              value={label}
              maxLength={200}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Alice Müller (ZEW) — alice@example.org"
              className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
            />
          </div>
          <div>
            <div className="text-[13px] font-medium text-stone-700">Scopes</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {allScopes.map((s) => {
                const on = scopes.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScope(s)}
                    className={
                      "rounded-full border px-3 py-1 text-xs font-medium transition " +
                      (on
                        ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                        : "border-stone-300 text-stone-600 hover:bg-stone-100")
                    }
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            {scopes.includes("admin") && (
              <p className="mt-2 text-xs text-amber-700">
                admin scope can mint and revoke keys — hand out sparingly.
              </p>
            )}
          </div>
          {scopes.includes("mcp") && (
            <div>
              <div className="text-[13px] font-medium text-stone-700">
                MCP tools
                <span className="ml-2 font-normal text-stone-400">
                  which tools this key may call (lit_search rides its own scope)
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {allTools.map((t) => {
                  const on = tools.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTool(t)}
                      className={
                        "rounded-full border px-3 py-1 text-xs font-medium transition " +
                        (on
                          ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                          : "border-stone-300 text-stone-600 hover:bg-stone-100")
                      }
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              {tools.length === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  No tools selected — this mcp key exposes no cheap tools.
                </p>
              )}
            </div>
          )}
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <div>
            <PrimaryButton type="submit" disabled={creating || !label.trim() || !scopes.length}>
              {creating ? "Creating…" : "Create key"}
            </PrimaryButton>
          </div>
        </form>
      </Card>

      {/* List */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <SectionLabel>Issued keys</SectionLabel>
          <label className="flex items-center gap-1.5 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
            />
            Show revoked
          </label>
        </div>
        {listError && <p className="mt-3 text-sm text-red-600">{listError}</p>}
        {loading && keys.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">No keys yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-stone-500">
                  <th className="py-2 pr-3 font-semibold">Label</th>
                  <th className="py-2 pr-3 font-semibold">Scopes</th>
                  <th className="py-2 pr-3 font-semibold">ID</th>
                  <th className="py-2 pr-3 font-semibold">Created</th>
                  <th className="py-2 pr-3 font-semibold">State</th>
                  <th className="py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const revoked = Boolean(k.revoked_at);
                  return (
                    <tr
                      key={k.id}
                      className={"border-t border-[var(--border-soft)] " + (revoked ? "opacity-55" : "")}
                    >
                      <td className="py-2 pr-3">
                        <span className="text-stone-800">{k.label}</span>
                        {k.rate_limit_overrides && (
                          <span className="ml-2 text-[11px] text-stone-500">
                            {JSON.stringify(k.rate_limit_overrides)}
                          </span>
                        )}
                        {Array.isArray(k.tools) && (
                          <span className="ml-2 text-[11px] text-stone-500">
                            tools: {k.tools.length ? k.tools.join(", ") : "none"}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="text-stone-600">{(k.scopes ?? []).join(", ")}</span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[12px] text-stone-500">{k.id}</td>
                      <td className="py-2 pr-3 text-stone-500">{fmtDate(k.created_at)}</td>
                      <td className="py-2 pr-3">
                        {revoked ? (
                          <span className="text-stone-500">revoked</span>
                        ) : (
                          <span className="text-[var(--sim-hi)]">active</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {!revoked &&
                          (confirmRevoke === k.id ? (
                            <span className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => onRevoke(k.id)}
                                className="rounded border border-[var(--sim-lo)] px-2 py-1 text-xs text-[var(--sim-lo)] hover:bg-red-50"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRevoke(null)}
                                className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <GhostButton onClick={() => setConfirmRevoke(k.id)} title="Revoke this key">
                              Revoke
                            </GhostButton>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Minted-key reveal — shown once, never recoverable */}
      {minted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-[520px] p-5">
            <SectionLabel>Key created — copy it now</SectionLabel>
            <p className="mt-2 text-[13px] text-stone-600">
              This is the only time <span className="font-medium">{minted.label}</span>’s key is shown.
              It is not stored and cannot be recovered.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg border border-[var(--border-soft)] bg-[var(--bg-card-2)] px-3 py-2 font-mono text-[12px] text-stone-800">
                {minted.key}
              </code>
              <GhostButton onClick={copyMinted}>{copied ? "Copied" : "Copy"}</GhostButton>
            </div>
            <p className="mt-2 text-[12px] text-stone-500">
              Scopes: {(minted.scopes ?? []).join(", ")}
              {Array.isArray(minted.tools) ? ` · tools: ${minted.tools.length ? minted.tools.join(", ") : "none"}` : ""}
              {" · id "}
              {minted.id}
            </p>
            <div className="mt-4 flex justify-end">
              <PrimaryButton onClick={() => setMinted(null)}>I’ve saved it</PrimaryButton>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
