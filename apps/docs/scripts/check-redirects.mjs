// Checks the redirect registry in redirects.mjs.
//
//   node scripts/check-redirects.mjs         source checks, no build needed
//   node scripts/check-redirects.mjs --dist  also checks the built site
//
// The source checks reject loops, chains, self-redirects, malformed paths,
// destinations that are not pages, sources that are still real pages, and
// source links that point at a redirect instead of its canonical page. The
// --dist checks confirm that Astro emitted each redirect page, that it points
// at a page that exists, and that no built page links through a redirect.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { redirects } from "../redirects.mjs";
import {
  docsRoot,
  generatedRoutePrefixes,
  linksInSource,
  resolveInternal,
  sourcePages,
} from "./docs-routes.mjs";
import { aliasLinkProblems, registryProblems } from "./redirect-rules.mjs";

const distMode = process.argv.includes("--dist");
const problems = [];

const pages = sourcePages();
const routes = new Set(pages.map((page) => page.route));

problems.push(
  ...registryProblems(redirects, {
    routes,
    generatedPrefixes: generatedRoutePrefixes,
  }),
);

/** @type {{ where: string, target: string }[]} */
const links = [];
for (const page of pages) {
  for (const { value, line } of linksInSource(page.text)) {
    const target = resolveInternal(value, page.route);
    if (target) links.push({ where: `${page.file}:${line}`, target });
  }
}
// The Setup Advisor builds its links in the browser, so no page contains them.
const advisor = join(docsRoot, "src/setup-advisor/model.ts");
for (const [index, text] of readFileSync(advisor, "utf8")
  .split("\n")
  .entries()) {
  const href = /^\s*href:\s*"([^"]+)"/.exec(text)?.[1];
  const target = href && resolveInternal(href, "/setup/");
  if (target) {
    links.push({
      where: `${relative(docsRoot, advisor)}:${index + 1}`,
      target,
    });
  }
}
problems.push(...aliasLinkProblems(links, redirects));

if (distMode) {
  const dist = join(docsRoot, "dist");
  const pageFile = (/** @type {string} */ route) =>
    join(dist, route.slice(1), "index.html");

  for (const [from, to] of Object.entries(redirects)) {
    const file = pageFile(from);
    if (!existsSync(file)) {
      problems.push(`${from}: Astro did not build a redirect page`);
      continue;
    }
    const html = readFileSync(file, "utf8");
    const refresh = /http-equiv="refresh"\s+content="0;\s*url=([^"]+)"/.exec(
      html,
    )?.[1];
    if (refresh !== to) {
      problems.push(
        `${from}: the built redirect goes to ${refresh ?? "nowhere"}, not ${to}`,
      );
    }
    if (!existsSync(pageFile(to))) {
      problems.push(`${from}: the destination ${to} was not built`);
    }
  }

  /** @param {string} directory @returns {string[]} */
  const htmlFiles = (directory) =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return htmlFiles(path);
      return name.endsWith(".html") ? [path] : [];
    });

  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, "utf8");
    // A redirect page links to its own destination, not through a redirect.
    if (/http-equiv="refresh"/.test(html)) continue;
    const route = `/${relative(dist, file)
      .split("\\")
      .join("/")
      .replace(/(^|\/)index\.html$/, "$1")}`;
    /** @type {{ where: string, target: string }[]} */
    const pageLinks = [];
    for (const [, value] of html.matchAll(/\shref="([^"]*)"/g)) {
      const target = resolveInternal(value ?? "", route);
      if (target) pageLinks.push({ where: relative(dist, file), target });
    }
    problems.push(...aliasLinkProblems(pageLinks, redirects));
  }
}

if (problems.length > 0) {
  console.error([...new Set(problems)].join("\n"));
  console.error(`\nRedirect check failed: ${new Set(problems).size} problems.`);
  process.exit(1);
}

console.log(
  `Redirect check passed for ${Object.keys(redirects).length} redirects${
    distMode ? " and the built site" : ""
  }.`,
);
