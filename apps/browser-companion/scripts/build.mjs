import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// One self-contained bundle per entry: the extension ships no
// node_modules, so workspace imports must be inlined. IIFE keeps the
// dynamically registered content script loadable as a classic script.
const esbuild = join(root, "..", "..", "node_modules", ".bin", "esbuild");
for (const entry of ["background", "content", "popup"]) {
  execFileSync(
    esbuild,
    [
      join(root, "src", `${entry}.ts`),
      "--bundle",
      "--format=iife",
      "--platform=browser",
      "--target=es2022",
      "--log-level=warning",
      `--outfile=${join(dist, `${entry}.js`)}`,
    ],
    { stdio: "inherit" },
  );
}
for (const file of ["manifest.json", "popup.html"]) {
  copyFileSync(join(root, file), join(dist, file));
}
console.log("companion built");
