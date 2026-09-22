// vitest/config re-exports Vite's defineConfig with the `test` key typed, so the shared test
// setup below is checked rather than silently ignored.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
