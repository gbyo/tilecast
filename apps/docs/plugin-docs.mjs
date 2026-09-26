// @ts-check
// Plugin documentation lives with each plugin, in plugins/<name>/docs/, and
// is declared in its tilecast.plugin.json. This module reads those manifests
// when the docs site builds so pages, sidebar entries, and edit links need no
// central list. Nothing is copied into apps/docs.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { glob } from "astro/loaders";
import { slug as githubSlug } from "github-slugger";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginsRoot = new URL("../../plugins/", import.meta.url);
const coreDocs = "apps/docs/src/content/docs/";

/**
 * @typedef {{ id: string, source: string, label?: string, pluginId: string,
 *   pluginName: string, group: string, badge?: string }} PluginDocPage
 */

/** @returns {PluginDocPage[]} every plugin page, by plugin name then manifest order */
export function pluginDocPages() {
  if (!existsSync(pluginsRoot)) return [];
  const pages = [];
  for (const dir of readdirSync(pluginsRoot).sort()) {
    const manifestUrl = new URL(`${dir}/tilecast.plugin.json`, pluginsRoot);
    if (!existsSync(manifestUrl)) continue;
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    for (const page of manifest.docs?.pages ?? []) {
      pages.push({
        id: page.slug,
        source: `plugins/${dir}/${page.source.slice(2)}`,
        label: page.label,
        pluginId: manifest.id,
        pluginName: manifest.name,
        group: page.sidebar?.group ?? "plugins",
        badge: page.sidebar?.badge,
      });
    }
  }
  return pages.sort((left, right) =>
    left.pluginName.localeCompare(right.pluginName),
  );
}

/**
 * Starlight sidebar items for one group.
 * @param {string} group
 */
export function pluginSidebarItems(group) {
  return pluginDocPages()
    .filter((page) => page.group === group)
    .map((page) => ({
      slug: page.id,
      ...(page.label ? { label: page.label } : {}),
      ...(page.badge
        ? {
            badge: { text: page.badge, variant: /** @type {const} */ ("note") },
          }
        : {}),
    }));
}

/**
 * The docs collection loader: Starlight's own pages and every plugin page in
 * one glob, because a collection's loader owns all of its entries. Core pages
 * keep the IDs Starlight's docsLoader gives them; a plugin page takes the slug
 * its manifest declares.
 */
export function docsCollectionLoader() {
  const plugins = new Map(pluginDocPages().map((page) => [page.source, page]));
  return glob({
    base: repositoryRoot,
    pattern: [
      `${coreDocs}**/[^_]*.{markdown,mdown,mkdn,mkd,mdwn,md,mdx}`,
      ...[...plugins.keys()],
    ],
    generateId({ entry, data }) {
      const plugin = plugins.get(entry);
      if (plugin) return plugin.id;
      if (typeof data.slug === "string") return data.slug;
      return entry
        .slice(coreDocs.length)
        .replace(/\.[^.]+$/, "")
        .split("/")
        .map((segment) => githubSlug(segment))
        .join("/")
        .replace(/\/index$/, "");
    },
  });
}

/**
 * The page actions (Copy page, View as Markdown) serve a cleaned Markdown copy
 * of each page next to it. Their plugin copies only src/content/docs, so the
 * docs site publishes plugin pages' copies itself, cleaned the same way for
 * the constructs plugin pages use: frontmatter becomes the title heading, and
 * imports and Starlight components are reduced to plain Markdown.
 * @param {string} source
 */
export function pageMarkdown(source) {
  const outsideCode = (
    /** @type {string} */ text,
    /** @type {(value: string) => string} */ transform,
  ) =>
    text
      .split(/(```[\s\S]*?```)/g)
      .map((part, index) => (index % 2 === 1 ? part : transform(part)))
      .join("");
  let title = "";
  let body = source;
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(
    body,
  );
  if (frontmatter) {
    title =
      /title:\s*["']?([^"'\n]+)["']?/.exec(frontmatter[1] ?? "")?.[1]?.trim() ??
      "";
    body = frontmatter[2] ?? "";
  }
  body = outsideCode(body, (text) =>
    text
      .replace(/^import\s+.*?;\s*\r?\n?/gm, "")
      .replace(
        /<\s*\/?\s*(Steps|CardGrid|FileTree|Tabs|TabItem|Icon)\b[^>]*>\s*/g,
        "",
      )
      .replace(
        /<Aside\b([^>]*)>([\s\S]*?)<\/\s*Aside\s*>/g,
        (_, attributes, content) => {
          const heading =
            /title=["']([^"']+)["']/.exec(attributes)?.[1] ??
            { tip: "Tip", caution: "Caution", danger: "Danger" }[
              /type=["']([^"']+)["']/.exec(attributes)?.[1] ?? ""
            ] ??
            "Note";
          return `**${heading}:** ${String(content).trim()}`;
        },
      )
      .replace(
        /<Badge\s+(?=[^>]*text=["']([^"']+)["'])[^>]*\/?\s*>/g,
        (_, text) => text,
      )
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ""),
  );
  body = outsideCode(body, withoutHtmlComments);
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return `${title ? `# ${title}\n\n` : ""}${body}\n`;
}

/**
 * Remove HTML comments, and any comment opener or closer left over, until
 * nothing changes. One pass is not enough: removing `<!---->` from
 * `<!<!---->--` leaves a new `<!--`.
 *
 * The result is only ever a Markdown copy of committed repository source,
 * served as `text/markdown` or written as a `.md` file; the HTML page is
 * rendered by Astro from the MDX itself. This is cleanup, not an HTML
 * sanitizer, but a stray opener would hide the rest of the copy in any
 * Markdown renderer, so it must not survive.
 * @param {string} text
 */
export function withoutHtmlComments(text) {
  const OPEN = "<!--";
  const CLOSE = "-->";
  let previous;
  do {
    previous = text;
    let out = "";
    let index = 0;
    for (;;) {
      const open = text.indexOf(OPEN, index);
      if (open < 0) {
        out += text.slice(index);
        break;
      }
      out += text.slice(index, open);
      const close = text.indexOf(CLOSE, open + OPEN.length);
      // An unterminated opener is dropped on its own; the text after it stays.
      index = close < 0 ? open + OPEN.length : close + CLOSE.length;
    }
    text = out.split(CLOSE).join("");
  } while (text !== previous);
  return text;
}

/**
 * An Astro integration that publishes `<slug>.md` for each plugin page, at
 * build time and from the development server.
 * @returns {import("astro").AstroIntegration}
 */
export function pluginPageMarkdown() {
  const read = (/** @type {PluginDocPage} */ page) =>
    pageMarkdown(
      readFileSync(
        new URL(page.source, new URL("../../", import.meta.url)),
        "utf8",
      ),
    );
  return {
    name: "tilecast-plugin-page-markdown",
    hooks: {
      "astro:server:setup"({ server }) {
        server.middlewares.use((request, response, next) => {
          const path = decodeURIComponent(
            (request.url ?? "").split("?")[0] ?? "",
          );
          const page = pluginDocPages().find((candidate) =>
            path.endsWith(`/${candidate.id}.md`),
          );
          if (!page) return next();
          response.setHeader("Content-Type", "text/markdown; charset=utf-8");
          response.end(read(page));
        });
      },
      "astro:build:done"({ dir }) {
        for (const page of pluginDocPages()) {
          const target = new URL(`${page.id}.md`, dir);
          mkdirSync(new URL(".", target), { recursive: true });
          writeFileSync(target, read(page));
        }
      },
    },
  };
}
