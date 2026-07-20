import { spawn } from "child_process";
import { openSync, readSync, closeSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { parseRawEvent, type RawSandboxEvent } from "./events.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_R = resolve(__dir, "../../../sandbox/run.R");
const SANDBOX_SH = resolve(__dir, "../../bin/run-sandbox.sh");

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDIO_BYTES = 256 * 1024;
const FD3_POLL_MS = 120;

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

  // The sandbox reports structured events on fd 3. We back fd 3 with a real file
  // rather than an anonymous pipe: the R side reopens it via `file("/dev/fd/3")`,
  // and on Linux `/dev/fd/N` for a pipe resolves to `pipe:[inode]` which cannot
  // be reopened (ENXIO) — a regular file's /proc/self/fd path reopens fine on
  // both Linux and macOS. We tail the file while the child runs.
  const fd3Path = join(tmpdir(), `eddysearch_fd3_${Date.now()}_${Math.random().toString(36).slice(2)}.jsonl`);

  return new Promise((resolve_) => {
    const events: RawSandboxEvent[] = [];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let fd3ByteCount = 0;
    let truncated = false;
    let fd3LineBuffer = "";

    let wfd: number;
    let rfd: number;
    try {
      wfd = openSync(fd3Path, "w"); // child inherits this as fd 3
      rfd = openSync(fd3Path, "r"); // we tail from here
    } catch (err) {
      resolve_({
        events,
        exitCode: null,
        stdout: "",
        stderr: `fd3 file setup failed: ${(err as Error).message}`,
        timedOut: false,
      });
      return;
    }

    let readPos = 0;
    const readBuf = Buffer.allocUnsafe(64 * 1024);
    const drainFd3 = (): void => {
      if (truncated) return;
      for (;;) {
        let n = 0;
        try {
          n = readSync(rfd, readBuf, 0, readBuf.length, readPos);
        } catch {
          break;
        }
        if (n <= 0) break;
        readPos += n;
        fd3ByteCount += n;
        if (fd3ByteCount > maxEventBytes) {
          truncated = true;
          const truncEvent: RawSandboxEvent = {
            type: "error",
            message: "FD-3 event stream exceeded 2 MB limit; truncated",
            recoverable: false,
          };
          events.push(truncEvent);
          onEvent(truncEvent);
          return;
        }
        fd3LineBuffer += readBuf.toString("utf-8", 0, n);
        const lines = fd3LineBuffer.split("\n");
        fd3LineBuffer = lines.pop()!;
        for (const line of lines) parseFd3Line(line, events, onEvent);
      }
    };

    const timeoutSecs = String(Math.ceil(timeoutMs / 1000));
    const child = spawn(SANDBOX_SH, [scriptPath, dbPath, RUN_R, timeoutSecs], {
      stdio: ["ignore", "pipe", "pipe", wfd],
    });

    const poll = setInterval(drainFd3, FD3_POLL_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const cleanup = (): void => {
      clearInterval(poll);
      clearTimeout(timer);
      try { closeSync(rfd); } catch { /* ignore */ }
      try { closeSync(wfd); } catch { /* ignore */ }
      try { unlinkSync(fd3Path); } catch { /* ignore */ }
    };

    child.stdout!.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });

    child.on("close", (code) => {
      drainFd3(); // final tail
      if (!truncated) parseFd3Line(fd3LineBuffer, events, onEvent);
      cleanup();
      resolve_({
        events,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").slice(0, maxStdioBytes),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").slice(0, maxStdioBytes),
        timedOut,
      });
    });

    child.on("error", (err) => {
      cleanup();
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
