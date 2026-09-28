import { defineConfig } from "@playwright/test";
import functional from "../playwright.config";

export default defineConfig({
  ...functional,
  testDir: ".",
  globalSetup: "../global-setup.ts",
  retries: 0,
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/linux/{arg}{ext}",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      stylePath: "./screenshot.css",
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
      caret: "hide",
    },
  },
  projects: [{ name: "chromium" }],
  use: {
    ...functional.use,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/Chicago",
    reducedMotion: "reduce",
    colorScheme: "light",
  },
});
