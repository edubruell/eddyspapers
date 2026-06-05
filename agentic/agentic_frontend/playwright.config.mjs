import { defineConfig, devices } from "@playwright/test";

const MOCK_PORT = 8011;
const WEB_PORT = 4399;

// Two web servers: the hermetic mock backend (replays a recorded SSE fixture)
// and the Astro dev server pointed at it. No live LLM/DB — fully repeatable.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node tests/mock-server.mjs`,
      env: { MOCK_PORT: String(MOCK_PORT) },
      url: `http://localhost:${MOCK_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: `astro dev --port ${WEB_PORT}`,
      env: { PUBLIC_AGENTIC_API_BASE: `http://localhost:${MOCK_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
  ],
});
