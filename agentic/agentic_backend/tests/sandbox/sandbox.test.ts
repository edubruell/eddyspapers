import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseRawEvent, assignSeq } from "../../src/sandbox/events.js";
import { checkScript } from "../../src/sandbox/checkScript.js";
import { runSandbox } from "../../src/sandbox/runSandbox.js";
import { resolveSnapshot } from "../../src/sandbox/snapshot.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const GOOD_SCRIPTS_DIR = resolve(__dir, "../../../r/tests/ast/good");
const BAD_SCRIPTS_DIR = resolve(__dir, "../../../r/tests/ast/bad");

const snap = await resolveSnapshot();
const hasDb = snap.exists;
const dbPath = snap.path;

function makeTempScript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  const path = join(dir, "script.R");
  writeFileSync(path, content, "utf-8");
  return path;
}

// ── Unit: events ────────────────────────────────────────────────────────────

describe("parseRawEvent", () => {
  it("parses a valid progress event", () => {
    const result = parseRawEvent({ type: "progress", label: "searching..." });
    expect(result).toEqual({ type: "progress", label: "searching..." });
  });

  it("parses a valid note event", () => {
    const result = parseRawEvent({ type: "note", markdown: "## hello" });
    expect(result).toEqual({ type: "note", markdown: "## hello" });
  });

  it("returns null for unknown type", () => {
    expect(parseRawEvent({ type: "unknown_event" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseRawEvent(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseRawEvent("not an object")).toBeNull();
  });

  it("returns null for event with missing required field", () => {
    expect(parseRawEvent({ type: "error" })).toBeNull();
  });

  it("strips unknown extra fields via zod", () => {
    const result = parseRawEvent({ type: "note", markdown: "hi", extra: "ignored" });
    expect(result).toEqual({ type: "note", markdown: "hi" });
  });
});

describe("assignSeq", () => {
  it("assigns monotonic seq from 0", () => {
    const events = [
      { type: "note" as const, markdown: "a" },
      { type: "progress" as const, label: "b" },
      { type: "note" as const, markdown: "c" },
    ];
    const seqd = assignSeq(events);
    expect(seqd.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("returns empty array for empty input", () => {
    expect(assignSeq([])).toEqual([]);
  });
});

// ── Integration: checkScript ─────────────────────────────────────────────────

describe("checkScript", () => {
  it("accepts a good script", async () => {
    const result = await checkScript(join(GOOD_SCRIPTS_DIR, "01_semantic_basic.R"));
    expect(result.ok).toBe(true);
  });

  it("rejects a bad script with reason", async () => {
    const result = await checkScript(join(BAD_SCRIPTS_DIR, "bad_library.R"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a nonexistent script gracefully", async () => {
    const result = await checkScript("/tmp/does_not_exist_xyz.R");
    expect(result.ok).toBe(false);
  });
});

// ── Integration: resolveSnapshot ─────────────────────────────────────────────

describe("resolveSnapshot", () => {
  it("returns a SnapshotInfo with a path", async () => {
    const snap = await resolveSnapshot();
    expect(typeof snap.path).toBe("string");
    expect(snap.path.length).toBeGreaterThan(0);
  });
});

// ── Integration: runSandbox ──────────────────────────────────────────────────

describe("runSandbox E2E", () => {
  it.skipIf(!hasDb)("emits note event end-to-end", async () => {
    const script = makeTempScript(`emit_note("hello sandbox")`);
    const collected: string[] = [];
    const result = await runSandbox(script, dbPath, (e) => {
      if (e.type === "note") collected.push(e.markdown);
    });
    expect(collected).toContain("hello sandbox");
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(!hasDb)("kills process on timeout", async () => {
    const script = makeTempScript(`Sys.sleep(60)`);
    const start = Date.now();
    const result = await runSandbox(script, dbPath, () => {}, { timeoutMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });

  it.skipIf(process.platform !== "linux" || !hasDb)(
    "OOM-killed script exits with non-zero code",
    async () => {
      const script = makeTempScript(`x <- numeric(2e9); emit_note("done")`);
      const result = await runSandbox(script, dbPath, () => {});
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).not.toBe(0);
    }
  );

  it.skipIf(!hasDb)("truncates FD-3 stream when over maxEventBytes", async () => {
    const longStr = "x".repeat(100);
    const script = makeTempScript(
      Array.from({ length: 10 }, (_, i) => `emit_note("${longStr} ${i}")`).join("\n")
    );
    const result = await runSandbox(script, dbPath, () => {}, { maxEventBytes: 200 });
    const hasError = result.events.some(
      (e) => e.type === "error" && e.message.includes("truncated")
    );
    expect(hasError).toBe(true);
  });
});
