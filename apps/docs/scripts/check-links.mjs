// Checks every internal link and asset reference in the built site.
//
// Content pages use relative links so they survive a change of base path or
// language. A mistake in one of those links only shows up as a 404 on the
// deployed site, so this script resolves each one against `dist/` after the
// build and fails when a target page, file, or heading anchor is missing.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const base = "/";
const site = "https://tilecast.org";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const retiredRepository = /github\.com\/Gibsonmb71\//i;

function htmlFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

function pageUrl(file) {
  const path = relative(dist, file).split("\\").join("/");
  if (path === "404.html") return new URL(base, site);
  return new URL(base + path.replace(/(^|\/)index\.html$/, "$1"), site);
}

function targetFile(url) {
  const path = decodeURIComponent(url.pathname.slice(base.length));
  const file = join(dist, path);
  if (path === "" || path.endsWith("/")) return join(file, "index.html");
  return file;
}

const ids = new Map();
function anchorsIn(file) {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(
      file,
      new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
    );
  }
  return ids.get(file);
}

const problems = [];
const pages = htmlFiles(dist);

for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const from = pageUrl(file);
  for (const [, attribute, value] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const where = `${relative(dist, file)}: ${attribute}="${value}"`;
    if (retiredRepository.test(value)) {
      problems.push(`${where} points to the retired repository`);
      continue;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) || value === "") continue;

    const url = new URL(value, from);
    if (url.origin !== site) continue;
    if (!url.pathname.startsWith(base)) {
      problems.push(`${where} is outside the ${base} base path`);
      continue;
    }

    const target = targetFile(url);
    if (!existsSync(target)) {
      problems.push(`${where} has no target in dist/`);
      continue;
    }
    const anchor = decodeURIComponent(url.hash.slice(1));
    if (anchor && anchor !== "_top" && target.endsWith(".html")) {
      if (!anchorsIn(target).has(anchor)) {
        problems.push(`${where} has no #${anchor} heading`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\nLink check failed: ${problems.length} broken references.`);
  process.exit(1);
}

console.log(`Link check passed for ${pages.length} pages.`);
