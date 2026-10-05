// Checks that every built page can be reached from the navigation.
//
// The sidebar is a short task map, so most pages are not in it. A page that is
// not in the sidebar must be linked from another page's content, normally the
// hub for its section. This script fails when a page has neither, so a new
// guide can't be published where nobody can find it. Redirect pages and the
// 404 page are exempt.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInternal } from "./docs-routes.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

/** @param {string} directory @returns {string[]} */
function htmlFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

/** @param {string} html @returns {string[]} */
const hrefsIn = (html) =>
  [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1] ?? "");

/** @param {string} file */
const routeOf = (file) =>
  `/${relative(dist, file)
    .split("\\")
    .join("/")
    .replace(/(^|\/)index\.html$/, "$1")}`;

/** @type {Map<string, string>} route to page HTML */
const pages = new Map();
for (const file of htmlFiles(dist)) {
  if (relative(dist, file) === "404.html") continue;
  const html = readFileSync(file, "utf8");
  if (/http-equiv="refresh"/.test(html)) continue;
  pages.set(routeOf(file), html);
}

const reachable = new Set(["/"]);
const sidebarPage = pages.get("/getting-started/");
const sidebar =
  /<nav class="sidebar[^>]*aria-label="Main">[\s\S]*?<\/nav>/.exec(
    sidebarPage ?? "",
  )?.[0];
if (!sidebar) {
  console.error(
    "Navigation check failed: found no sidebar on /getting-started/.",
  );
  process.exit(1);
}
for (const value of hrefsIn(sidebar)) {
  const target = resolveInternal(value, "/getting-started/");
  if (target) reachable.add(target);
}

for (const [route, html] of pages) {
  const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";
  for (const value of hrefsIn(main)) {
    const target = resolveInternal(value, route);
    if (target && target !== route) reachable.add(target);
  }
}

const unreachable = [...pages.keys()].filter((route) => !reachable.has(route));
if (unreachable.length > 0) {
  console.error(
    unreachable
      .map(
        (route) =>
          `${route} is not in the sidebar and no page links to it. Link it from the hub for its section.`,
      )
      .join("\n"),
  );
  console.error(`\nNavigation check failed: ${unreachable.length} pages.`);
  process.exit(1);
}

console.log(`Navigation check passed for ${pages.size} pages.`);
