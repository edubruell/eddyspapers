import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { z } from "zod";

const __dir = dirname(fileURLToPath(import.meta.url));
const CHECK_R = resolve(__dir, "../../../r/check.R");
const CHECK_SH = resolve(__dir, "../../bin/check.sh");

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; offendingNode: string; hint: string };

const checkResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    offending_node: z.string().default(""),
    hint: z.string().default(""),
  }),
]);

function parseCheckOutput(raw: string): CheckResult {
  const result = checkResultSchema.safeParse(JSON.parse(raw));
  if (!result.success) return { ok: false, reason: "unexpected check output", offendingNode: "", hint: "" };
  if (result.data.ok) return { ok: true };
  return {
    ok: false,
    reason: result.data.reason,
    offendingNode: result.data.offending_node,
    hint: result.data.hint,
  };
}

export async function checkScript(scriptPath: string): Promise<CheckResult> {
  return new Promise((resolve_) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const child = spawn(CHECK_SH, [scriptPath, CHECK_R], {
      stdio: ["ignore", "pipe", "ignore"],
      signal: controller.signal,
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });

    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve_(parseCheckOutput(stdout.trim()));
      } catch {
        resolve_({ ok: false, reason: "could not parse check output", offendingNode: "", hint: "" });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const isAbort = err.name === "AbortError";
      resolve_({
        ok: false,
        reason: isAbort ? "check script timed out" : `spawn error: ${err.message}`,
        offendingNode: "",
        hint: "",
      });
    });
  });
}
