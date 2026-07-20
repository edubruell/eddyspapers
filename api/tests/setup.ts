import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Give every test worker its own appdata.duckdb. DuckDB takes an exclusive cross-process
// file lock, so parallel vitest files sharing the default path would collide when a route
// under requireKey() opens the key registry. Tests that inspect key state override
// AGENTIC_APPDATA_PATH themselves (this only sets a default when none is provided).
if (!process.env.AGENTIC_APPDATA_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-appdata-"));
  process.env.AGENTIC_APPDATA_PATH = join(dir, "appdata.duckdb");
}
