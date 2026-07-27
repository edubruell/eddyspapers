import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { SearchDb } from "../../src/db/searches.js";
import type { AgentInput } from "../../src/agent/types.js";

let tmp: string;
let db: SearchDb;

function input(brief: string): AgentInput & { dbSnapshotDate: string } {
  return { brief, categories: null, minYear: null, dbSnapshotDate: "2026-06-01" } as AgentInput & {
    dbSnapshotDate: string;
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-claim-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  const { openSearchDb } = await import("../../src/db/searches.js");
  db = await openSearchDb();
});

afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("claimSearch (S8 — atomic run claim)", () => {
  it("claims an absent run exactly once", async () => {
    expect(await db.claimSearch("a", input("brief"))).toBe(true);
    // A second concurrent identical POST must NOT re-claim a running run.
    expect(await db.claimSearch("a", input("brief"))).toBe(false);
  });

  it("does not re-claim a done run", async () => {
    await db.claimSearch("a", input("brief"));
    await db.finalizeSearch("a", "done", "synthesis");
    expect(await db.claimSearch("a", input("brief"))).toBe(false);
  });

  it("does not re-claim a run awaiting clarification", async () => {
    await db.claimSearch("a", input("brief"));
    await db.setAwaitingClarification("a", "Which years?");
    expect(await db.claimSearch("a", input("brief"))).toBe(false);
    expect((await db.getSearch("a"))?.status).toBe("awaiting_clarification");
  });

  it("reclaims a previously errored run and resets it to running", async () => {
    await db.claimSearch("a", input("brief"));
    await db.finalizeSearch("a", "error", "");
    expect(await db.claimSearch("a", input("brief"))).toBe(true);
    expect((await db.getSearch("a"))?.status).toBe("running");
  });
});
