// vitest/config re-exports Vite's defineConfig with the `test` key typed, so the shared test
// setup below is checked rather than silently ignored.
import { defineConfig } from "vitest/config";
import optimizeLocales from "@react-aria/optimize-locales-plugin";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";

export default defineConfig({
  plugins: [
    macros.vite(),
    react(),
    {
      ...optimizeLocales.vite({ locales: ["en"] }),
      enforce: "pre",
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
    },
  },
  build: {
    sourcemap: true,
    target: ["es2022"],
    cssMinify: "lightningcss",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            /macro-(.*)\.css$/.test(id) ||
            /@react-spectrum\/s2\/.*\.css$/.test(id)
          ) {
            return "s2-styles";
          }
        },
      },
    },
  },
  test: {
    setupFiles: ["./src/testSetup.ts"],
    server: { deps: { inline: ["@react-spectrum/s2"] } },
  },
});
