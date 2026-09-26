// vitest/config re-exports Vite's defineConfig with the `test` key typed, so the shared test
// setup below is checked rather than silently ignored.
import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const studioPluginDependencies = [
  "react",
  "react-dom",
  "react-router",
  "react-i18next",
  "i18next",
  "@tanstack/react-query",
  "react-hook-form",
  "@hookform/resolvers",
  "zod",
  "lucide-react",
  "date-fns",
  "recharts",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The Studio surface bundled plugins build on (plugins/*/studio).
      "@tilecast/studio": fileURLToPath(
        new URL("./src/plugin-host/kit.ts", import.meta.url),
      ),
    },
    // Plugin Studio code lives in plugins/, outside this package. Resolve the
    // libraries it shares with Studio from here so there is exactly one copy
    // of each (one React, one router, one query cache).
    dedupe: studioPluginDependencies,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
    },
  },
  build: { sourcemap: true },
  test: { setupFiles: ["./src/testSetup.ts"] },
});
