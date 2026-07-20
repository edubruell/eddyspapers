import { useState, useEffect } from "react";
import { checkAuth, setKey } from "../../lib/api.js";
import LogoAgentic from "../logo/LogoAgentic.jsx";
import { PrimaryButton } from "../primitives/index.jsx";

// Shared-password wall in front of the whole app. On mount it probes /auth/check with the
// stored key: if the backend gate is disabled (or the stored key is still valid) it opens
// straight through; otherwise it shows the lock screen. This auto-adapts to whether the
// server actually enforces AGENTIC_PASSWORD, so dev stays frictionless.
export default function Gate({ children }) {
  const [status, setStatus] = useState("checking"); // checking | locked | open
  const [pw, setPw] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    checkAuth(undefined, { signal: controller.signal })
      .then((ok) => setStatus(ok ? "open" : "locked"))
      .catch(() => setStatus("locked"));
    return () => controller.abort();
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const candidate = pw.trim();
    if (!candidate) return;
    setSubmitting(true);
    setError(null);
    try {
      const ok = await checkAuth(candidate);
      if (ok) {
        setKey(candidate);
        setStatus("open");
      } else {
        setError("Incorrect password.");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "open") return children;

  if (status === "checking") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-stone-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-6 pt-16">
      <LogoAgentic />
      <form
        onSubmit={onSubmit}
        className="w-full rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-card)] p-5 shadow-sm"
      >
        <label htmlFor="agentic-pw" className="block text-sm font-medium text-stone-700">
          This is a private preview
        </label>
        <p className="mt-1 text-[13px] text-stone-500">
          Enter the access password to continue.
        </p>
        <input
          id="agentic-pw"
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          className="mt-3 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4">
          <PrimaryButton type="submit" disabled={submitting || !pw.trim()}>
            {submitting ? "Checking…" : "Enter"}
          </PrimaryButton>
        </div>
      </form>
    </div>
  );
}
