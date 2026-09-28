import { defineConfig } from "vite";

// Builds the conformance fixture host (dist/conformance/conformance-host.js),
// the script every engine runner injects before the runtime starts. It is a
// test artifact and is never part of dist/runtime.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/conformance",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    lib: {
      entry: "conformance/host/conformance-host.ts",
      formats: ["iife"],
      name: "TilecastConformanceHost",
      fileName: () => "conformance-host.js",
    },
  },
});
