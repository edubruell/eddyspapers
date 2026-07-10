import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SearchDb } from "../../src/db/searches.js";
import type { AgentInput } from "../../src/agent/types.js";

// openSearchDb resolves AGENTIC_DB_PATH lazily, so stubbing the env before the
// call is enough to keep each test on its own throwaway DuckDB file.

let tmp: string;
let db: SearchDb;

function input(brief: string, extra: Partial<AgentInput> = {}): AgentInput & { dbSnapshotDate: string } {
  return {
    brief,
    categories: null,
    minYear: null,
    dbSnapshotDate: "2026-06-01",
    ...extra,
  } as AgentInput & { dbSnapshotDate: string };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agentic-stats-"));
  vi.stubEnv("AGENTIC_DB_PATH", join(tmp, "searches.duckdb"));
  const { openSearchDb } = await import("../../src/db/searches.js");
  db = await openSearchDb();
});

afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("getStats", () => {
  it("returns zeros on an empty table", async () => {
    const stats = await db.getStats(30);
    expect(stats).toEqual({
      days: 30,
      total_searches: 0,
      by_status: {},
      clarified: 0,
      refined: 0,
    });
  });

  it("counts runs, status buckets, clarifier and refine usage", async () => {
    await db.upsertSearch("a", input("first brief"));
    await db.upsertSearch("b", input("second brief", { refine: true }));
    await db.upsertSearch("c", input("third brief"));
    await db.finalizeSearch("a", "done", "## review");
    await db.finalizeSearch("b", "error", "");
    await db.setAwaitingClarification("c", "Which years?");

    const stats = await db.getStats(7);
    expect(stats.days).toBe(7);
    expect(stats.total_searches).toBe(3);
    expect(stats.by_status).toEqual({ done: 1, error: 1, awaiting_clarification: 1 });
    expect(stats.clarified).toBe(1);
    expect(stats.refined).toBe(1);
  });

  it("serialises to JSON without BigInt leaks", async () => {
    await db.upsertSearch("a", input("brief"));
    const stats = await db.getStats(30);
    expect(() => JSON.stringify(stats)).not.toThrow();
  });
});

// DuckDB now() stamps created_at in local time, so "today" must be computed in
// local time as well — new Date().toISOString() is UTC and made this test fail
// between midnight and 0+offset local (found 2026-07-10).
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("getDailyLogs", () => {
  it("returns rows for today with event counts and flags", async () => {
    await db.upsertSearch("a", input("logged brief", { refine: true }));
    await db.appendEvents("a", [
      { type: "stage", seq: 1, stage: "write", state: "enter" },
      { type: "stage", seq: 2, stage: "write", state: "exit", ms: 5 },
    ]);
    await db.finalizeSearch("a", "done", "## review");

    const today = localToday();
    const rows = await db.getDailyLogs(today);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "a",
      status: "done",
      brief: "logged brief",
      refine: true,
      clarified: false,
      n_events: 2,
      has_synthesis: true,
    });
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  it("returns an empty array for a day with no runs", async () => {
    await db.upsertSearch("a", input("brief"));
    const rows = await db.getDailyLogs("1999-01-01");
    expect(rows).toEqual([]);
  });
});

// ── Backdated-row tests ──────────────────────────────────────────────────────
// created_at is DEFAULT now() and the SearchDb interface exposes no raw SQL, so
// window-boundary tests seed a separate DuckDB file directly, close it (releasing
// the file lock), then re-stub AGENTIC_DB_PATH and open it through openSearchDb.

const RAW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS searches (
    id VARCHAR PRIMARY KEY,
    brief TEXT NOT NULL,
    categories TEXT,
    min_year INTEGER,
    db_snapshot_date VARCHAR,
    created_at TIMESTAMP DEFAULT now(),
    status VARCHAR DEFAULT 'running',
    events TEXT,
    synthesis TEXT,
    clarify_question TEXT,
    clarify_answer TEXT,
    refine BOOLEAN DEFAULT false
  )
`;

async function seedRawDb(path: string, inserts: string[]): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  await conn.run(RAW_SCHEMA);
  await inserts.reduce(
    (prev, sql) => prev.then(async () => void (await conn.run(sql))),
    Promise.resolve(),
  );
  conn.closeSync();
  instance.closeSync();
}

async function openSeededDb(path: string, inserts: string[]): Promise<SearchDb> {
  await seedRawDb(path, inserts);
  vi.stubEnv("AGENTIC_DB_PATH", path);
  const { openSearchDb } = await import("../../src/db/searches.js");
  return openSearchDb();
}

describe("getStats days window", () => {
  it("excludes rows older than the window and keeps rows inside it", async () => {
    const wdb = await openSeededDb(join(tmp, "window.duckdb"), [
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('old', 'old brief', '[]', 'done', now() - INTERVAL 10 DAY)`,
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('recent', 'recent brief', '[]', 'done', now() - INTERVAL 3 DAY)`,
    ]);
    try {
      const narrow = await wdb.getStats(7);
      expect(narrow.total_searches).toBe(1);
      expect(narrow.by_status).toEqual({ done: 1 });

      const wide = await wdb.getStats(30);
      expect(wide.total_searches).toBe(2);
      expect(wide.by_status).toEqual({ done: 2 });
    } finally {
      await wdb.close();
    }
  });

  it("counts clarified/refined only within the window", async () => {
    const wdb = await openSeededDb(join(tmp, "window2.duckdb"), [
      `INSERT INTO searches (id, brief, events, status, clarify_question, refine, created_at)
       VALUES ('old', 'old brief', '[]', 'done', 'Which years?', true, now() - INTERVAL 10 DAY)`,
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('recent', 'recent brief', '[]', 'done', now())`,
    ]);
    try {
      const narrow = await wdb.getStats(7);
      expect(narrow.clarified).toBe(0);
      expect(narrow.refined).toBe(0);

      const wide = await wdb.getStats(30);
      expect(wide.clarified).toBe(1);
      expect(wide.refined).toBe(1);
    } finally {
      await wdb.close();
    }
  });
});

describe("getDailyLogs day boundary", () => {
  it("includes midnight of the day, excludes midnight of the next day, and orders by time", async () => {
    const wdb = await openSeededDb(join(tmp, "days.duckdb"), [
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('late', 'late brief', '[]', 'done', TIMESTAMP '2026-01-02 23:59:59')`,
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('start', 'start brief', '[]', 'done', TIMESTAMP '2026-01-02 00:00:00')`,
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('next', 'next-day brief', '[]', 'done', TIMESTAMP '2026-01-03 00:00:00')`,
      `INSERT INTO searches (id, brief, events, status, created_at)
       VALUES ('prev', 'prev-day brief', '[]', 'done', TIMESTAMP '2026-01-01 23:59:59')`,
    ]);
    try {
      const rows = await wdb.getDailyLogs("2026-01-02");
      expect(rows.map((r) => r.id)).toEqual(["start", "late"]);
    } finally {
      await wdb.close();
    }
  });

  it("handles legacy rows with NULL events and NULL refine", async () => {
    const wdb = await openSeededDb(join(tmp, "legacy.duckdb"), [
      `INSERT INTO searches (id, brief, events, refine, status, created_at)
       VALUES ('legacy', 'legacy brief', NULL, NULL, 'done', TIMESTAMP '2026-01-02 12:00:00')`,
    ]);
    try {
      const rows = await wdb.getDailyLogs("2026-01-02");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "legacy",
        refine: false,
        clarified: false,
        n_events: 0,
        has_synthesis: false,
      });
      expect(() => JSON.stringify(rows)).not.toThrow();
    } finally {
      await wdb.close();
    }
  });
});

describe("clarifier lifecycle in stats", () => {
  it("still counts a run as clarified after the answer is recorded and the run finishes", async () => {
    await db.upsertSearch("a", input("brief"));
    await db.setAwaitingClarification("a", "Which years?");
    expect(await db.recordClarifyAnswer("a", "2015 onwards")).toBe(true);
    await db.finalizeSearch("a", "done", "## review");

    const stats = await db.getStats(7);
    expect(stats.clarified).toBe(1);
    expect(stats.by_status).toEqual({ done: 1 });

    const today = localToday();
    const rows = await db.getDailyLogs(today);
    expect(rows[0]?.clarified).toBe(true);
  });
});

// ── Route-level tests ────────────────────────────────────────────────────────
// Hermetic: env.js and the DB singleton are mocked (same pattern as
// tests/routes/stats.test.ts), so these exercise auth wiring + query validation
// without touching DuckDB or the network.

describe("stats routes", () => {
  const fakeLogs = [
    {
      id: "x",
      created_at: "2026-06-11 10:00:00",
      status: "done" as const,
      brief: "a brief",
      refine: false,
      clarified: false,
      n_events: 3,
      has_synthesis: true,
    },
  ];

  const getStats = vi.fn(async (days: number) => ({
    days,
    total_searches: 2,
    by_status: { done: 2 },
    clarified: 1,
    refined: 0,
  }));
  const getDailyLogs = vi.fn(async (_day: string) => fakeLogs);

  const loadRoute = async (password: string) => {
    vi.resetModules();
    // requireKey reads the grandfathered password live from process.env (parity with the
    // appdata path), so stub it there — not just in the env.js mock (which only feeds
    // /last_updated's SEMANTIC_API_BASE / EDDYPAPERS_API_KEY).
    vi.stubEnv("AGENTIC_PASSWORD", password);
    vi.doMock("../../src/env.js", () => ({
      env: {
        AGENTIC_PASSWORD: password,
        SEMANTIC_API_BASE: "https://example.test/api",
        EDDYPAPERS_API_KEY: "",
      },
    }));
    vi.doMock("../../src/db/singleton.js", () => ({
      getSearchDb: async () => ({ getStats, getDailyLogs }),
      // requireKey('admin') resolves keys through the registry → getAppDataDb; no keys
      // provisioned here, so the grandfathered password is the only admission path.
      getAppDataDb: async () => ({ activeKeys: async () => [] }),
    }));
    const { statsRoute } = await import("../../src/routes/stats.js");
    return statsRoute;
  };

  afterEach(() => {
    getStats.mockClear();
    getDailyLogs.mockClear();
    vi.unstubAllEnvs();
    vi.doUnmock("../../src/env.js");
    vi.doUnmock("../../src/db/singleton.js");
    vi.resetModules();
  });

  it("rejects /searches without a key when the gate is enabled", async () => {
    const route = await loadRoute("s3cret");
    const res = await route.request("/searches");
    expect(res.status).toBe(401);
    expect(getStats).not.toHaveBeenCalled();
  });

  it("rejects /dailylogs with a wrong key when the gate is enabled", async () => {
    const route = await loadRoute("s3cret");
    const res = await route.request("/dailylogs?day=2026-06-11", {
      headers: { "x-agentic-key": "nope" },
    });
    expect(res.status).toBe(401);
    expect(getDailyLogs).not.toHaveBeenCalled();
  });

  it("serves /searches with the x-agentic-key header and defaults days to 30", async () => {
    const route = await loadRoute("s3cret");
    const res = await route.request("/searches", {
      headers: { "x-agentic-key": "s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ days: 30, total_searches: 2 });
    expect(getStats).toHaveBeenCalledWith(30);
  });

  it("serves /searches with a Bearer token and passes days through", async () => {
    const route = await loadRoute("s3cret");
    const res = await route.request("/searches?days=7", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    expect(getStats).toHaveBeenCalledWith(7);
  });

  it.each(["0", "-3", "2.5", "abc"])("rejects days=%s with 400", async (days) => {
    const route = await loadRoute("");
    const res = await route.request(`/searches?days=${days}`);
    expect(res.status).toBe(400);
    expect(getStats).not.toHaveBeenCalled();
  });

  it("serves /dailylogs for a well-formed day", async () => {
    const route = await loadRoute("s3cret");
    const res = await route.request("/dailylogs?day=2026-06-11", {
      headers: { "x-agentic-key": "s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fakeLogs);
    expect(getDailyLogs).toHaveBeenCalledWith("2026-06-11");
  });

  it.each(["", "2026-6-1", "20260611", "tomorrow"])(
    "rejects malformed day=%s with 400",
    async (day) => {
      const route = await loadRoute("");
      const res = await route.request(`/dailylogs?day=${day}`);
      expect(res.status).toBe(400);
      expect(getDailyLogs).not.toHaveBeenCalled();
    },
  );

  it("leaves both routes open when the gate is disabled", async () => {
    const route = await loadRoute("");
    const statsRes = await route.request("/searches");
    const logsRes = await route.request("/dailylogs?day=2026-06-11");
    expect(statsRes.status).toBe(200);
    expect(logsRes.status).toBe(200);
  });
});
