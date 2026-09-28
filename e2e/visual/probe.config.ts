import { defineConfig } from "@playwright/test";
import visual from "./playwright.config";

export default defineConfig({
  ...visual,
  testMatch: "regression.probe.ts",
  updateSnapshots: "none",
  outputDir: "./test-results/probe",
});
