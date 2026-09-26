import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Builds the browser half of the runtime: one classic, deterministic script
// (dist/runtime/runtime.js). Static files (index.html, runtime.css, fonts and
// the logo) are copied by scripts/finish-runtime.mjs so their names never
// change; hosts validate runtime paths against a fixed grammar.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  publicDir: false,
  define: {
    __RUNTIME_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist/runtime",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
    modulePreload: false,
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "TilecastPlayerRuntime",
      fileName: () => "runtime.js",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
