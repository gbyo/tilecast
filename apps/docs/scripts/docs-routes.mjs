// @ts-check
// Shared helpers for the docs checks: the public routes the site builds from
// source, and a way to find and resolve the internal links in a page.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { slug as githubSlug } from "github-slugger";
import { pluginDocPages } from "../plugin-docs.mjs";

export const docsRoot = fileURLToPath(new URL("../", import.meta.url));
export const contentRoot = join(docsRoot, "src/content/docs");

/** A throwaway origin: only paths matter, and it never reaches a network. */
const origin = "https://docs.invalid";

/** Routes the OpenAPI plugin generates. They have no source file. */
export const generatedRoutePrefixes = ["/reference/api/endpoints/"];

/** @param {string} directory @returns {string[]} */
function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(md|mdx)$/.test(name) && !name.startsWith("_") ? [path] : [];
  });
}

/**
 * @typedef {{ file: string, route: string, text: string }} SourcePage
 * file is relative to the docs workspace; route is the public path.
 */

/** @param {string} text */
function frontmatterSlug(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^slug:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1];
}

/** @param {string} id @returns {string} */
const routeOfId = (id) => (id === "" || id === "index" ? "/" : `/${id}/`);

/** Every core and plugin page the docs collection loads. @returns {SourcePage[]} */
export function sourcePages() {
  const pages = sourceFiles(contentRoot).map((path) => {
    const text = readFileSync(path, "utf8");
    const id =
      frontmatterSlug(text) ??
      relative(contentRoot, path)
        .replace(/\.[^.]+$/, "")
        .split(/[\\/]/)
        .map((segment) => githubSlug(segment))
        .join("/")
        .replace(/\/index$/, "");
    return {
      file: relative(docsRoot, path),
      route: routeOfId(id),
      text,
    };
  });
  for (const plugin of pluginDocPages()) {
    const path = fileURLToPath(
      new URL(`../../../${plugin.source}`, import.meta.url),
    );
    pages.push({
      file: relative(docsRoot, path),
      route: routeOfId(plugin.id),
      text: readFileSync(path, "utf8"),
    });
  }
  return pages;
}

/**
 * Raw internal-link candidates in Markdown or MDX source, with line numbers.
 * Fenced code is skipped, so a command in a code block is never a link.
 * @param {string} text
 * @returns {{ value: string, line: number }[]}
 */
export function linksInSource(text) {
  /** @type {{ value: string, line: number }[]} */
  const found = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    if (/^\s*(```|~~~)/.test(content)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = index + 1;
    for (const match of content.matchAll(/\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
      found.push({ value: match[1] ?? "", line });
    }
    for (const match of content.matchAll(/\b(?:href|link)=["']([^"']+)["']/g)) {
      found.push({ value: match[1] ?? "", line });
    }
    // Frontmatter such as a hero action: `link: getting-started/`.
    const key = /^\s*(?:-\s*)?link:\s*["']?([^\s"']+)["']?\s*$/.exec(content);
    if (key) found.push({ value: key[1] ?? "", line });
  });
  return found;
}

/**
 * Resolve a link found on a page to an internal route, or undefined for an
 * external link, a bare anchor, or another scheme.
 * @param {string} value
 * @param {string} fromRoute route of the page that holds the link
 * @returns {string | undefined} a path that ends in a slash when it is a page
 */
export function resolveInternal(value, fromRoute) {
  if (value === "" || value.startsWith("#")) return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return undefined;
  let url;
  try {
    url = new URL(value, origin + fromRoute);
  } catch {
    return undefined;
  }
  const path = decodeURIComponent(url.pathname);
  // A file such as /llms.txt or an image is not a page route.
  if (/\.[a-z0-9]+$/i.test(path.split("/").pop() ?? "")) return undefined;
  return path.endsWith("/") ? path : `${path}/`;
}
