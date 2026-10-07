import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 20000 },
  outputDir: "test-results",
  reporter: "list",
  use: {
    baseURL: "https://localhost:18981",
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
    // Only the ephemeral local fixture uses a self-signed certificate.
    // Chromium's service-worker fetch needs process-level fixture trust.
    launchOptions: { args: ["--ignore-certificate-errors"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node apps/player-web/e2e/server.mjs",
    cwd: "../../..",
    url: "https://localhost:18981/readyz",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
