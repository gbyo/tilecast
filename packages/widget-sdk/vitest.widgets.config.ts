import { defineConfig } from "vitest/config";

// The Widget catalog suite: every module below widgets/ (its own tests and
// the discovery, manifest and fixture checks in test/widgets/) in jsdom.
// `npm run widgets:check` runs it after widgetctl's static checks.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: [
      "test/widgets/**/*.test.ts",
      "../../widgets/*/runtime/**/*.test.ts",
    ],
  },
});
