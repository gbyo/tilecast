import { defineConfig } from "@playwright/test";
import functional from "../playwright.config";

// Same installation and safety check as the browser suite. Documentation
// captures are source assets, independent of visual-regression baselines.
export default defineConfig({
  ...functional,
  testDir: ".",
  globalSetup: "../global-setup.ts",
  retries: 0,
  outputDir: "./test-results",
  reporter: "list",
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
