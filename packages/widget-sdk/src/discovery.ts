/**
 * Build-time Widget discovery. A host (the Player Runtime, Studio,
 * Storybook) resolves its trusted source set when it is built and passes
 * the results here with an explicit source for every entry:
 *
 *   widgets/<name>/tilecast.widget.json (+ runtime/index.ts)      core
 *   plugins/<plugin>/widgets/<name>/tilecast.widget.json (...)    plugin
 *
 * Ownership is passed structurally by the caller, never inferred here from
 * a bare directory name. Every definition must agree with its manifest. A
 * Widget that does not is left out with a diagnostic instead of being
 * allowed to destabilize a display, and each host's tests fail on any
 * diagnostic, so a mismatch never reaches a release. Nothing central
 * lists Widgets: a contributor adds a Widget directory and the toolchain
 * finds it.
 *
 * This module imports no validation library: it runs inside the Player
 * bundle. widgetctl validates manifests fully with ./manifest.ts.
 */
import {
  definitionProblem,
  WidgetRegistry,
  type AnyWidgetDefinition,
} from "./definition.ts";
import type { WidgetManifestInput } from "./manifest.ts";
import {
  packageOwnsType,
  sourceProblem,
  type ExtensionSource,
} from "./source.ts";

export interface DiscoveredWidget {
  /** Human-readable location, e.g. `widgets/clock` or `plugins/athletics/widgets/scoreboard`. */
  readonly dir: string;
  readonly manifest: WidgetManifestInput;
  readonly definition: AnyWidgetDefinition;
  readonly source: ExtensionSource;
}

export interface WidgetDiscovery {
  readonly widgets: readonly DiscoveredWidget[];
  readonly problems: readonly string[];
  readonly registry: WidgetRegistry;
}

type ManifestModules = Record<string, WidgetManifestInput>;
type RuntimeModules = Record<string, { default?: unknown }>;

/** One trusted manifest/module pair with its explicit source. */
export interface WidgetSourceEntry {
  readonly manifestPath: string;
  readonly modulePath?: string;
  readonly manifest?: WidgetManifestInput;
  readonly module?: { default?: unknown };
  readonly source: ExtensionSource;
}

function problemFor(problems: string[], dir: string) {
  return (message: string) => problems.push(`${dir}: ${message}`);
}

function entryDir(entry: WidgetSourceEntry): string {
  const pluginManifest =
    /(^|\/)(plugins\/[^/]+\/widgets\/[^/]+)\/tilecast\.widget\.json$/.exec(
      entry.manifestPath,
    );
  if (pluginManifest?.[2]) return pluginManifest[2];
  const coreManifest = /(^|\/)(widgets\/[^/]+)\/tilecast\.widget\.json$/.exec(
    entry.manifestPath,
  );
  if (coreManifest?.[2]) return coreManifest[2];
  const pluginModule =
    /(^|\/)(plugins\/[^/]+\/widgets\/[^/]+)\/runtime\/index\.ts$/.exec(
      entry.modulePath ?? "",
    );
  if (pluginModule?.[2]) return pluginModule[2];
  const coreModule = /(^|\/)(widgets\/[^/]+)\/runtime\/index\.ts$/.exec(
    entry.modulePath ?? "",
  );
  if (coreModule?.[2]) return coreModule[2];
  throw new Error(`not a Widget path: ${entry.manifestPath}`);
}

function sourcePathProblem(entry: WidgetSourceEntry): string | null {
  const source = entry.source;
  if (source.kind === "core") {
    if (
      /(^|\/)widgets\/[^/]+\/tilecast\.widget\.json$/.test(entry.manifestPath)
    ) {
      return null;
    }
    return `core Widget must live at widgets/<name>/tilecast.widget.json (saw ${entry.manifestPath})`;
  }
  if (source.kind === "plugin") {
    const match =
      /(^|\/)plugins\/([^/]+)\/widgets\/[^/]+\/tilecast\.widget\.json$/.exec(
        entry.manifestPath,
      );
    if (!match) {
      return `plugin Widget must live at plugins/<plugin>/widgets/<name>/tilecast.widget.json (saw ${entry.manifestPath})`;
    }
    if (match[2] !== source.pluginId) {
      return `plugin Widget path ${entry.manifestPath} does not match source plugin ${source.pluginId}`;
    }
    return null;
  }
  return null;
}

function ownershipProblem(
  type: string,
  source: ExtensionSource,
): string | null {
  if (type.startsWith("tilecast.") && source.kind !== "core") {
    return `type ${type} uses the reserved tilecast namespace but comes from a non-core source`;
  }
  if (source.kind === "package" && !packageOwnsType(source.packageId, type)) {
    return `type ${type} is outside package namespace ${source.packageId}`;
  }
  return null;
}

function directoryOf(path: string): string {
  const match = /\/widgets\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a Widget path: ${path}`);
  return match[1];
}

const PLUGIN_MANIFEST_PATTERN =
  /(^|\/)plugins\/([^/]+)\/widgets\/[^/]+\/tilecast\.widget\.json$/;
const PLUGIN_MODULE_PATTERN =
  /(^|\/)plugins\/([^/]+)\/widgets\/[^/]+\/runtime\/index\.ts$/;

/** The explicit source a manifest path structurally belongs to. */
export function sourceForWidgetManifestPath(path: string): ExtensionSource {
  const plugin = PLUGIN_MANIFEST_PATTERN.exec(path);
  if (plugin?.[2]) return { kind: "plugin", pluginId: plugin[2] };
  return { kind: "core" };
}

/** The explicit source a runtime module path structurally belongs to. */
export function sourceForWidgetModulePath(path: string): ExtensionSource {
  const plugin = PLUGIN_MODULE_PATTERN.exec(path);
  if (plugin?.[2]) return { kind: "plugin", pluginId: plugin[2] };
  return { kind: "core" };
}

/**
 * Pair `import.meta.glob` manifest and module records into source entries.
 * Ownership comes from each path's structure; callers pass one trusted glob
 * pair at a time (core, then each plugin root) and concatenate the results.
 */
export function pairSourcedEntries(
  manifests: Record<string, WidgetManifestInput | undefined>,
  modules: Record<string, { default?: unknown }>,
): WidgetSourceEntry[] {
  const leafOf = (path: string) =>
    path.split("/widgets/")[1]?.split("/")[0] ?? path;
  const keyOf = (path: string, source: ExtensionSource) =>
    source.kind === "plugin"
      ? `plugin:${source.pluginId}:${leafOf(path)}`
      : `core:${leafOf(path)}`;
  const byKey = new Map<string, WidgetSourceEntry>();
  for (const [path, manifest] of Object.entries(manifests)) {
    if (manifest === undefined) continue;
    const source = sourceForWidgetManifestPath(path);
    byKey.set(keyOf(path, source), {
      manifestPath: path,
      manifest,
      source,
    });
  }
  for (const [path, module] of Object.entries(modules)) {
    const source = sourceForWidgetModulePath(path);
    const manifestPath = path.replace(
      /\/runtime\/index\.ts$/,
      "/tilecast.widget.json",
    );
    const key = keyOf(manifestPath, source);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, modulePath: path, module });
    } else {
      byKey.set(key, {
        manifestPath,
        modulePath: path,
        module,
        source,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Discover Widgets from explicit source entries. Validates cross-source
 * collisions for provider identity, component type, custom-element tag,
 * and source ownership.
 */
export function discoverSourcedWidgets(
  entries: readonly WidgetSourceEntry[],
): WidgetDiscovery {
  const problems: string[] = [];
  const widgets: DiscoveredWidget[] = [];
  const ids = new Map<string, string>();
  const types = new Map<string, string>();
  const tags = new Map<string, string>();
  const dirKey = (entry: WidgetSourceEntry) => {
    try {
      return entryDir(entry);
    } catch {
      return entry.manifestPath;
    }
  };
  // Core entries win collisions, so they process first; every other
  // source follows in directory order. The first declaration of an id,
  // type, or tag keeps it, and the diagnostic names the rejected
  // entry's directory.
  const ordered = [...entries].sort((a, b) => {
    const ca = a.source.kind === "core" ? 0 : 1;
    const cb = b.source.kind === "core" ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const ka = dirKey(a);
    const kb = dirKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const entry of ordered) {
    let dir: string;
    try {
      dir = entryDir(entry);
    } catch {
      problems.push(`entry: not a Widget path: ${entry.manifestPath}`);
      continue;
    }
    const problem = problemFor(problems, dir);
    const sourceIssue = sourceProblem(entry.source);
    if (sourceIssue) {
      problem(sourceIssue);
      continue;
    }
    const pathIssue = sourcePathProblem(entry);
    if (pathIssue) {
      problem(pathIssue);
      continue;
    }
    const manifest = entry.manifest;
    if (!manifest) {
      problem("has runtime/index.ts but no tilecast.widget.json");
      continue;
    }
    const component = manifest.component;
    if (!component) {
      problem("tilecast.widget.json declares no component");
      continue;
    }
    if (entry.modulePath === undefined && entry.module === undefined) {
      problem(`declares ${component.entrypoint} but it does not exist`);
      continue;
    }
    const invalid = definitionProblem(entry.module?.default);
    if (invalid) {
      problem(invalid);
      continue;
    }
    const typed = entry.module!.default as AnyWidgetDefinition;
    const mismatch = [
      typed.type !== component.type && `type ${typed.type} ≠ ${component.type}`,
      typed.version !== component.version &&
        `version ${typed.version} ≠ ${component.version}`,
      typed.tagName !== component.tagName &&
        `tag ${typed.tagName} ≠ ${component.tagName}`,
    ].filter(Boolean);
    if (mismatch.length > 0) {
      problem(`definition does not match its manifest: ${mismatch.join("; ")}`);
      continue;
    }
    const owned = ownershipProblem(typed.type, entry.source);
    if (owned) {
      problem(owned);
      continue;
    }
    const id = (manifest as { id?: unknown }).id;
    if (typeof id === "string") {
      const owner = ids.get(id);
      if (owner) {
        problem(`provider identity ${id} is also declared by ${owner}`);
        continue;
      }
    }
    const typeOwner = types.get(typed.type);
    if (typeOwner) {
      problem(`type ${typed.type} is also declared by ${typeOwner}`);
      continue;
    }
    const tagOwner = tags.get(typed.tagName);
    if (tagOwner) {
      problem(`tag ${typed.tagName} is also used by ${tagOwner}`);
      continue;
    }
    if (typeof id === "string") ids.set(id, dir);
    types.set(typed.type, dir);
    tags.set(typed.tagName, dir);
    widgets.push({
      dir,
      manifest,
      definition: typed,
      source: entry.source,
    });
  }
  const registry = new WidgetRegistry(widgets.map((w) => w.definition));
  return { widgets, problems, registry };
}

export function discoverWidgets(
  manifests: ManifestModules,
  modules: RuntimeModules,
): WidgetDiscovery {
  const manifestByDir = new Map<string, WidgetManifestInput>();
  const manifestPathByDir = new Map<string, string>();
  for (const [path, manifest] of Object.entries(manifests)) {
    manifestByDir.set(directoryOf(path), manifest);
    manifestPathByDir.set(directoryOf(path), path);
  }
  const moduleByDir = new Map<string, { default?: unknown }>();
  const modulePathByDir = new Map<string, string>();
  for (const [path, module] of Object.entries(modules)) {
    moduleByDir.set(directoryOf(path), module);
    modulePathByDir.set(directoryOf(path), path);
  }
  const dirs = [
    ...new Set([...manifestByDir.keys(), ...moduleByDir.keys()]),
  ].sort();
  return discoverSourcedWidgets(
    dirs.map((dir) => ({
      manifestPath:
        manifestPathByDir.get(dir) ?? `widgets/${dir}/tilecast.widget.json`,
      modulePath: modulePathByDir.get(dir),
      manifest: manifestByDir.get(dir) as WidgetManifestInput,
      module: moduleByDir.get(dir),
      source: { kind: "core" } as const,
    })),
  );
}
