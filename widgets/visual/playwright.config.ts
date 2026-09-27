import { defineConfig, devices } from "@playwright/test";

// Visual regression for Widgets V2: every Widget story, rendered by the
// production mount on a manual clock with reduced motion and the bundled
// face, compared with committed Linux Chromium baselines. No hosted service.
// Build the stories first: npm run widgets:visual does both.
export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: { baseURL: "http://localhost:6116", deviceScaleFactor: 1 },
  webServer: {
    command: "node serve.mjs",
    url: "http://localhost:6116/index.json",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1920 },
      },
    },
  ],
});
