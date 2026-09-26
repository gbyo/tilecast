/**
 * Plugin discovery. A plugin is a directory below plugins/ that contains a
 * tilecast.plugin.json; nothing else registers it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  pluginManifestSchema,
  type PluginManifest,
} from "../../src/manifest.ts";

export const MANIFEST_FILE = "tilecast.plugin.json";

export interface Problem {
  plugin?: string;
  file?: string;
  message: string;
}

export interface DiscoveredPlugin {
  /** Directory name, for example "countdown-bar". */
  dir: string;
  /** Absolute plugin directory. */
  path: string;
  manifest: PluginManifest;
  /** Go package name declared by the server entry point, when present. */
  goPackage: string | null;
}

export interface Repo {
  root: string;
  pluginsDir: string;
  plugins: DiscoveredPlugin[];
  problems: Problem[];
}

export function repoRoot(from: string = import.meta.dirname): string {
  return resolve(from, "..", "..", "..", "..");
}

/** The directory name a plugin ID must use: underscores become hyphens. */
export function dirForId(id: string): string {
  return id.replaceAll("_", "-");
}

export function discover(root: string): Repo {
  const pluginsDir = join(root, "plugins");
  const problems: Problem[] = [];
  const plugins: DiscoveredPlugin[] = [];
  const entries = existsSync(pluginsDir)
    ? readdirSync(pluginsDir).filter((name) =>
        statSync(join(pluginsDir, name)).isDirectory(),
      )
    : [];
  for (const dir of entries.sort()) {
    if (dir === "node_modules" || dir.startsWith(".")) continue;
    const path = join(pluginsDir, dir);
    const manifestPath = join(path, MANIFEST_FILE);
    const file = relative(root, manifestPath);
    if (!existsSync(manifestPath)) {
      problems.push({
        plugin: dir,
        file: relative(root, path),
        message: `directory has no ${MANIFEST_FILE}`,
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      problems.push({
        plugin: dir,
        file,
        message: `invalid JSON: ${String(error)}`,
      });
      continue;
    }
    const parsed = pluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({
          plugin: dir,
          file,
          message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        });
      }
      continue;
    }
    const manifest = parsed.data;
    plugins.push({
      dir,
      path,
      manifest,
      goPackage: goPackageOf(path, manifest),
    });
  }
  return { root, pluginsDir, plugins, problems };
}

function goPackageOf(path: string, manifest: PluginManifest): string | null {
  if (!manifest.server) return null;
  const entry = join(path, manifest.server.entrypoint);
  if (!existsSync(entry)) return null;
  const match = /^package\s+([a-z][a-z0-9_]*)\s*$/m.exec(
    readFileSync(entry, "utf8"),
  );
  return match?.[1] ?? null;
}

/** Every file below a directory, relative to it, sorted. */
export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(dir, full));
    }
  };
  visit(dir);
  return out;
}
