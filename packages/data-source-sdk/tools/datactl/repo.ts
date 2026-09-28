/**
 * Repository access for `data-sources:*`. Root modules live beneath
 * `data-sources/<name>/`; plugin-owned modules beneath
 * `plugins/<plugin>/data-sources/<name>/`. Plugin identity always comes
 * from the parent tilecast.plugin.json via the shared widgetctl resolver:
 * the directory is a location, never identity. Manifests are parsed but
 * not deeply validated here; `check` owns conformance.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionSource } from "@tilecast/widget-sdk";
import {
  pluginIdForDir,
  resolvePlugin,
  type ResolvedPlugin,
} from "../../../widget-sdk/tools/widgetctl/repo.ts";
import { MANIFEST_FILE } from "../../src/manifest.ts";

export { pluginIdForDir, resolvePlugin, type ResolvedPlugin };
export { MANIFEST_FILE };

export interface Problem {
  source: string;
  message: string;
}

export interface DiscoveredSource {
  /** Directory relative to the repository root. */
  dir: string;
  path: string;
  source: ExtensionSource;
  manifest: unknown;
}

export interface Repo {
  root: string;
  sources: DiscoveredSource[];
  problems: Problem[];
}

export function repoRoot(from: string = import.meta.dirname): string {
  return resolve(from, "../../../..");
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => {
      if (name === "node_modules" || name.startsWith(".")) return false;
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function discover(root: string): Repo {
  const problems: Problem[] = [];
  const sources: DiscoveredSource[] = [];
  const roots: { dir: string; path: string; source: ExtensionSource }[] = [];
  for (const name of listDirs(join(root, "data-sources"))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    roots.push({
      dir: `data-sources/${name}`,
      path: join(root, "data-sources", name),
      source: { kind: "core" },
    });
  }
  for (const plugin of listDirs(join(root, "plugins"))) {
    if (plugin === "node_modules" || plugin.startsWith(".")) continue;
    const names = listDirs(join(root, "plugins", plugin, "data-sources"));
    if (names.length === 0) continue;
    const resolved = pluginIdForDir(root, plugin);
    if (resolved === null) {
      problems.push({
        source: `plugins/${plugin}`,
        message: "directory owns Data Sources but has no tilecast.plugin.json",
      });
      continue;
    }
    if ("problem" in resolved) {
      problems.push({ source: `plugins/${plugin}`, message: resolved.problem });
      continue;
    }
    for (const name of names) {
      roots.push({
        dir: `plugins/${plugin}/data-sources/${name}`,
        path: join(root, "plugins", plugin, "data-sources", name),
        source: { kind: "plugin", pluginId: resolved.id },
      });
    }
  }
  for (const { dir, path, source } of roots) {
    const manifestPath = join(path, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      problems.push({ source: dir, message: `${MANIFEST_FILE} is missing` });
      continue;
    }
    try {
      sources.push({
        dir,
        path,
        source,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      });
    } catch {
      problems.push({
        source: dir,
        message: `${MANIFEST_FILE} is not valid JSON`,
      });
    }
  }
  return { root, sources, problems };
}

/** Repo-relative path for diagnostics. */
export function rel(root: string, path: string): string {
  return relative(root, path);
}
