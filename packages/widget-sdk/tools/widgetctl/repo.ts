/**
 * Widget module discovery for widgetctl. A Widget is a directory below
 * widgets/ or plugins/<plugin>/widgets/ that contains a
 * tilecast.widget.json; nothing else registers it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PLUGIN_ID_PATTERN, type ExtensionSource } from "../../src/source.ts";
import {
  widgetDirPattern,
  widgetFixtureSchema,
  widgetManifestSchema,
  type WidgetFixture,
  type WidgetManifest,
} from "../../src/manifest.ts";

export const MANIFEST_FILE = "tilecast.widget.json";

/** Tooling directories below widgets/ that are not Widget modules. */
export const RESERVED_DIRS = new Set(["visual", "storybook-static"]);

export interface Problem {
  widget?: string;
  file?: string;
  message: string;
}

export interface DiscoveredWidget {
  dir: string;
  path: string;
  source: ExtensionSource;
  manifest: WidgetManifest;
  fixtures: { file: string; fixture: WidgetFixture }[];
}

export interface Repo {
  root: string;
  widgetsDir: string;
  widgets: DiscoveredWidget[];
  problems: Problem[];
}

export function repoRoot(from: string = import.meta.dirname): string {
  return resolve(from, "..", "..", "..", "..");
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => {
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Resolve a plugin directory to the stable id in its tilecast.plugin.json.
 * The directory is a filesystem location, never identity: a null result
 * means the directory has no readable manifest and its Widgets cannot be
 * attributed to any plugin.
 */
export function pluginIdForDir(
  root: string,
  dir: string,
): { id: string } | { problem: string } | null {
  const manifestPath = join(root, "plugins", dir, "tilecast.plugin.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    return {
      problem: `plugins/${dir}/tilecast.plugin.json names no valid plugin id`,
    };
  }
  return { id };
}

export interface ResolvedPlugin {
  /** Directory basename below plugins/, for example "emergency-alerts". */
  dir: string;
  /** Stable id from the plugin's tilecast.plugin.json, for example "emergency_alerts". */
  id: string;
}

/**
 * Resolve a --plugin selector to its directory and stable id. The selector
 * may be either the manifest id or the directory basename; the manifest id
 * is identity either way. Returns null when no plugin matches.
 */
export function resolvePlugin(
  root: string,
  selector: string,
): ResolvedPlugin | null {
  for (const dir of listDirs(join(root, "plugins"))) {
    if (dir === "node_modules" || dir.startsWith(".")) continue;
    const resolved = pluginIdForDir(root, dir);
    if (resolved === null || "problem" in resolved) continue;
    if (dir === selector || resolved.id === selector) {
      return { dir, id: resolved.id };
    }
  }
  return null;
}

export function discover(root: string): Repo {
  const widgetsDir = join(root, "widgets");
  const problems: Problem[] = [];
  const widgets: DiscoveredWidget[] = [];
  const roots: { dir: string; path: string; source: ExtensionSource }[] = [];
  for (const name of listDirs(widgetsDir)) {
    if (
      name === "node_modules" ||
      name.startsWith(".") ||
      RESERVED_DIRS.has(name)
    ) {
      continue;
    }
    roots.push({
      dir: `widgets/${name}`,
      path: join(widgetsDir, name),
      source: { kind: "core" },
    });
  }
  for (const plugin of listDirs(join(root, "plugins"))) {
    if (plugin === "node_modules" || plugin.startsWith(".")) continue;
    const pluginWidgets = join(root, "plugins", plugin, "widgets");
    const names = listDirs(pluginWidgets);
    if (names.length === 0) continue;
    const resolved = pluginIdForDir(root, plugin);
    if (resolved === null) {
      problems.push({
        widget: `plugins/${plugin}`,
        message: `directory owns Widgets but has no tilecast.plugin.json`,
      });
      continue;
    }
    if ("problem" in resolved) {
      problems.push({ widget: `plugins/${plugin}`, message: resolved.problem });
      continue;
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      roots.push({
        dir: `plugins/${plugin}/widgets/${name}`,
        path: join(pluginWidgets, name),
        source: { kind: "plugin", pluginId: resolved.id },
      });
    }
  }
  for (const { dir, path, source } of roots) {
    const manifestPath = join(path, MANIFEST_FILE);
    const file = relative(root, manifestPath);
    const name = dir.split("/").pop() ?? dir;
    if (!widgetDirPattern.test(name)) {
      problems.push({ widget: dir, message: "directory name is invalid" });
      continue;
    }
    if (!existsSync(manifestPath)) {
      problems.push({
        widget: dir,
        message: `directory has no ${MANIFEST_FILE}`,
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = readJSON(manifestPath);
    } catch (error) {
      problems.push({
        widget: dir,
        file,
        message: `invalid JSON: ${String(error)}`,
      });
      continue;
    }
    const parsed = widgetManifestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({
          widget: dir,
          file,
          message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        });
      }
      continue;
    }
    const fixtures: DiscoveredWidget["fixtures"] = [];
    const fixtureDir = join(path, "fixtures");
    for (const name of existsSync(fixtureDir)
      ? readdirSync(fixtureDir)
          .filter((n) => n.endsWith(".json"))
          .sort()
      : []) {
      const fixtureFile = relative(root, join(fixtureDir, name));
      try {
        const fixture = widgetFixtureSchema.safeParse(
          readJSON(join(fixtureDir, name)),
        );
        if (fixture.success)
          fixtures.push({ file: fixtureFile, fixture: fixture.data });
        else
          for (const issue of fixture.error.issues)
            problems.push({
              widget: dir,
              file: fixtureFile,
              message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            });
      } catch (error) {
        problems.push({
          widget: dir,
          file: fixtureFile,
          message: `invalid JSON: ${String(error)}`,
        });
      }
    }
    widgets.push({ dir, path, source, manifest: parsed.data, fixtures });
  }
  return { root, widgetsDir, widgets, problems };
}
