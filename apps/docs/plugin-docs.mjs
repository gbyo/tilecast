// @ts-check
// Plugin documentation lives with each plugin, in plugins/<name>/docs/, and
// is declared in its tilecast.plugin.json. This module reads those manifests
// when the docs site builds so pages, sidebar entries, and edit links need no
// central list. Nothing is copied into apps/docs.
import { readdirSync, readFileSync, existsSync } from "node:fs";
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
