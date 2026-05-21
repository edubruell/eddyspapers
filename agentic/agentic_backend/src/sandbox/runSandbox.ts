import { spawn } from "child_process";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parseRawEvent, type RawSandboxEvent } from "./events.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_R = resolve(__dir, "../../../r/run.R");
const SANDBOX_SH = resolve(__dir, "../../bin/run-sandbox.sh");

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDIO_BYTES = 256 * 1024;

export interface RunSandboxOptions {
  timeoutMs?: number;
  maxEventBytes?: number;
  maxStdioBytes?: number;
}

export interface SandboxResult {
  events: RawSandboxEvent[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function parseFd3Line(line: string, events: RawSandboxEvent[], onEvent: (e: RawSandboxEvent) => void): void {
  if (line.trim() === "") return;
  try {
    const parsed = parseRawEvent(JSON.parse(line));
    if (parsed !== null) {
      events.push(parsed);
      onEvent(parsed);
    }
  } catch {
    // malformed JSON line — skip silently
  }
}

export async function runSandbox(
  scriptPath: string,
  dbPath: string,
  onEvent: (event: RawSandboxEvent) => void,
  opts?: RunSandboxOptions
): Promise<SandboxResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEventBytes = opts?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxStdioBytes = opts?.maxStdioBytes ?? DEFAULT_MAX_STDIO_BYTES;

  return new Promise((resolve_) => {
    const events: RawSandboxEvent[] = [];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let fd3ByteCount = 0;
    let truncated = false;
    let fd3LineBuffer = "";

    const timeoutSecs = String(Math.ceil(timeoutMs / 1000));
    const child = spawn(SANDBOX_SH, [scriptPath, dbPath, RUN_R, timeoutSecs], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const fd3 = child.stdio[3] as Readable;

    fd3.on("data", (chunk: Buffer) => {
      if (truncated) return;

      fd3ByteCount += chunk.length;

      if (fd3ByteCount > maxEventBytes) {
        truncated = true;
        const truncEvent: RawSandboxEvent = {
          type: "error",
          message: "FD-3 event stream exceeded 2 MB limit; truncated",
          recoverable: false,
        };
        events.push(truncEvent);
        onEvent(truncEvent);
        fd3.destroy();
        return;
      }

      fd3LineBuffer += chunk.toString("utf-8");
      const lines = fd3LineBuffer.split("\n");
      fd3LineBuffer = lines.pop()!;
      for (const line of lines) parseFd3Line(line, events, onEvent);
    });

    child.stdout!.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });

    child.on("close", (code) => {
      clearTimeout(timer);
      // flush any incomplete last line (only in non-truncated path)
      if (!truncated) parseFd3Line(fd3LineBuffer, events, onEvent);
      resolve_({
        events,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").slice(0, maxStdioBytes),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").slice(0, maxStdioBytes),
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve_({
        events,
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").slice(0, maxStdioBytes),
        stderr: err.message,
        timedOut,
      });
    });
  });
}
