import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 20000 },
  outputDir: "test-results",
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
