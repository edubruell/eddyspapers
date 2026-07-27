import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { SearchDb } from "../../src/db/searches.js";
import type { AgentInput } from "../../src/agent/types.js";

// openSearchDb resolves AGENTIC_DB_PATH lazily, so stubbing the env before the
// call is enough to keep each test on its own throwaway DuckDB file.

let tmp: string;
let db: SearchDb;

function input(brief: string): AgentInput & { dbSnapshotDate: string } {
  return {
    brief,
    categories: null,
    minYear: null,
    dbSnapshotDate: "2026-06-01",
  } as AgentInput & { dbSnapshotDate: string };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-sweep-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  const { openSearchDb } = await import("../../src/db/searches.js");
  db = await openSearchDb();
});

afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("expireStaleClarifications", () => {
  it("flips a stale awaiting_clarification run to error", async () => {
    await db.upsertSearch("a", input("stale brief"));
    await db.setAwaitingClarification("a", "Which years?");

    // maxAgeHours = 0 makes any row created before now() stale.
    const n = await db.expireStaleClarifications(0);
    expect(n).toBe(1);

    const row = await db.getSearch("a");
    expect(row?.status).toBe("error");
  });

  it("leaves a fresh awaiting run alone under a real threshold", async () => {
    await db.upsertSearch("a", input("fresh brief"));
    await db.setAwaitingClarification("a", "Which years?");

    const n = await db.expireStaleClarifications(24);
    expect(n).toBe(0);

    const row = await db.getSearch("a");
    expect(row?.status).toBe("awaiting_clarification");
  });

  it("never touches runs in other statuses", async () => {
    await db.upsertSearch("running", input("still running"));
    await db.upsertSearch("done", input("finished"));
    await db.finalizeSearch("done", "done", "## review");

    const n = await db.expireStaleClarifications(0);
    expect(n).toBe(0);

    expect((await db.getSearch("running"))?.status).toBe("running");
    expect((await db.getSearch("done"))?.status).toBe("done");
  });
});
