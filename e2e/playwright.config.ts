import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests for Tilecast Studio. They run against a real Demo Mode
// installation (`make demo`): real dashboard, real API, real PostgreSQL, and
// simulated players. Nothing here mocks an API response.
const baseURL =
  process.env.TILECAST_E2E_BASE_URL ??
  `http://localhost:${process.env.TILECAST_DEMO_PORT ?? "18080"}`;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Every test shares one installation and resets it, so they run in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "./test-results",
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
