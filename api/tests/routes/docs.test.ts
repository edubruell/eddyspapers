import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";

// GET /docs is the public field reference (src/docs/reference.ts). It exists because the one
// convention nobody guesses — author_lastnames is semicolon-separated — lived only in a
// private skill file, and the first external API user duly got it wrong. It must therefore be
// readable WITHOUT a key: the caller who most needs it is the one still working out auth.

let tmp: string;

async function buildAppWith(password: string): Promise<Hono> {
  vi.resetModules();
  vi.stubEnv("AGENTIC_PASSWORD", password);
  vi.stubEnv("AGENTIC_APPDATA_PATH", join(tmp, "appdata.duckdb"));
  const { buildApp } = await import("../../src/app.js");
  return buildApp();
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-docs-"));
});

afterEach(async () => {
  const { resetAppDataDb } = await import("../../src/db/singleton.js");
  await resetAppDataDb().catch(() => undefined);
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

interface Reference {
  auth: { scopes: { scope: string; grants: string }[]; note: string };
  conventions: Record<string, string>;
  endpoints: { method: string; path: string; fields: { name: string; doc: string }[] }[];
}

describe("GET /docs", () => {
  it("serves the reference without a key even when the gate is on", async () => {
    const app = await buildAppWith("zew-preview-pw");
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
  });

  it("states the semicolon convention for author_lastnames on the verify endpoint", async () => {
    const app = await buildAppWith("");
    const ref = (await (await app.request("/docs")).json()) as Reference;

    expect(ref.conventions.authorLastnames).toMatch(/SEMICOLON/);
    expect(ref.conventions.authorLastnames).toMatch(/Not comma-separated/i);

    const verify = ref.endpoints.find((e) => e.path === "/papers/verify");
    expect(verify).toBeDefined();
    const field = verify?.fields.find((f) => f.name === "entries[].author_lastnames");
    expect(field?.doc).toMatch(/SEMICOLON/);
  });

  it("documents that server-side synthesis is off by default and scope-gated", async () => {
    const app = await buildAppWith("");
    const ref = (await (await app.request("/docs")).json()) as Reference;

    expect(ref.auth.note).toMatch(/OFF by default/);
    const synth = ref.auth.scopes.find((s) => s.scope === "lit_search_synth");
    expect(synth?.grants).toMatch(/write/i);

    const chat = ref.endpoints.find((e) => e.path === "/chat");
    expect(chat?.fields.find((f) => f.name === "synthesize")?.doc).toMatch(/lit_search_synth/);
  });
});
