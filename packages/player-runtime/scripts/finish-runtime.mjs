#!/usr/bin/env node
// Completes dist/runtime after `vite build`: copies the static document,
// stylesheet, logo, bundled font subsets and their licence, then writes a
// manifest of every file with its SHA-256 so hosts and release tooling can
// verify the exact artifact they serve.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const out = path.join(root, "dist", "runtime");
const require = createRequire(import.meta.url);

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(from, path.join(out, to));
};

for (const name of ["index.html", "tilecast-logo-white.svg"]) {
  copy(path.join(root, "static", name), name);
}

// runtime.css keeps its fixed name: hosts validate the artifact set. It is
// the base stylesheet, then each runtime plugin's stylesheets, in path order
// so every build is byte-identical. The document policy refuses inline
// styles, so a plugin's rules must arrive here. `pluginctl check` keeps each
// plugin's selectors inside its own .tc-<name> namespace.
const repo = path.join(root, "..", "..");
const stylesheets = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true })
        .filter((name) => String(name).endsWith(".css"))
        .map((name) => path.join(dir, String(name)))
    : [];
const pluginStylesheets = [
  // MIGRATION ONLY: renderers not yet moved into their plugins.
  ...stylesheets(path.join(root, "src", "plugins", "builtin")),
  ...fs
    .readdirSync(path.join(repo, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      stylesheets(path.join(repo, "plugins", entry.name, "runtime")),
    ),
]
  .map((file) => path.relative(repo, file).split(path.sep).join("/"))
  .sort();
const css = [
  fs.readFileSync(path.join(root, "static", "runtime.css"), "utf8"),
  ...pluginStylesheets.map(
    (file) =>
      `/* ${file} */\n${fs.readFileSync(path.join(repo, file), "utf8")}`,
  ),
].join("\n");
fs.writeFileSync(path.join(out, "runtime.css"), css);
copy(path.join(root, "static", "fonts", "OFL.txt"), "fonts/OFL.txt");
const geist = path.dirname(
  require.resolve("@fontsource-variable/geist/package.json"),
);
for (const subset of [
  "latin",
  "latin-ext",
  "cyrillic",
  "cyrillic-ext",
  "vietnamese",
]) {
  const file = `geist-${subset}-wght-normal.woff2`;
  copy(path.join(geist, "files", file), `fonts/${file}`);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name !== "runtime-manifest.json") files.push(full);
  }
};
walk(out);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const manifest = {
  name: pkg.name,
  version: pkg.version,
  contractVersion: 1,
  files: files
    .map((file) => ({
      path: path.relative(out, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path)),
};
fs.writeFileSync(
  path.join(out, "runtime-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`finish-runtime: ${manifest.files.length} files in ${out}`);
