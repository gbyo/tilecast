/**
 * Source-aware discovery for declarative Data Source modules. A module is
 * discovered by its manifest path alone: data is declarative, so there is
 * no runtime module to pair. Ownership works exactly like Widgets: the
 * path gives a location, and the caller's resolver maps the plugin
 * directory to the stable tilecast.plugin.json id. Without a resolver the
 * directory basename is used (legacy behavior for unit tests); real hosts
 * always pass a resolver built from their trusted plugin manifest set.
 */
import { sourceProblem, type ExtensionSource } from "@tilecast/widget-sdk";
import {
  pluginIdResolver,
  type PluginIdResolver,
} from "@tilecast/widget-sdk/discovery";
import type { DataSourceManifestInput } from "./manifest.ts";

export type { PluginIdResolver };
export { pluginIdResolver };

/** One trusted manifest with its explicit source. */
export interface DataSourceEntry {
  readonly manifestPath: string;
  readonly manifest?: DataSourceManifestInput;
  readonly source: ExtensionSource;
}

const CORE_MANIFEST_PATTERN =
  /(^|\/)data-sources\/([^/]+)\/tilecast\.datasource\.json$/;
const PLUGIN_MANIFEST_PATTERN =
  /(^|\/)plugins\/([^/]+)\/data-sources\/([^/]+)\/tilecast\.datasource\.json$/;

/**
 * The explicit source a module manifest path structurally belongs to. The
 * plugin directory is a location, never identity; an unresolvable
 * directory yields an empty plugin id, which source validation rejects.
 */
export function sourceForDataSourceManifestPath(
  path: string,
  resolvePluginId?: PluginIdResolver,
): ExtensionSource {
  const plugin = PLUGIN_MANIFEST_PATTERN.exec(path);
  if (plugin?.[2]) {
    const dir = plugin[2];
    const pluginId = resolvePluginId ? (resolvePluginId(dir) ?? "") : dir;
    return { kind: "plugin", pluginId };
  }
  return { kind: "core" };
}

/** Human-readable location, e.g. `data-sources/rss` or `plugins/forms/data-sources/intake`. */
export function entryDir(entry: DataSourceEntry): string {
  const plugin = PLUGIN_MANIFEST_PATTERN.exec(entry.manifestPath);
  if (plugin?.[2] && plugin?.[3]) {
    return `plugins/${plugin[2]}/data-sources/${plugin[3]}`;
  }
  const core = CORE_MANIFEST_PATTERN.exec(entry.manifestPath);
  if (core?.[2]) return `data-sources/${core[2]}`;
  return entry.manifestPath;
}

export interface DataSourceDiscovery {
  readonly sources: { dir: string; source: ExtensionSource }[];
  readonly problems: string[];
}

/**
 * Discover Data Source modules from one trusted manifest glob. Entries
 * whose source cannot be validated, or whose plugin directory has no
 * manifest identity, are left out with a diagnostic.
 */
export function discoverSourcedDataSources(
  manifests: Record<string, DataSourceManifestInput | undefined>,
  resolvePluginId?: PluginIdResolver,
): DataSourceDiscovery {
  const sources: { dir: string; source: ExtensionSource }[] = [];
  const problems: string[] = [];
  const problemFor = (dir: string) => (message: string) => {
    problems.push(`${dir}: ${message}`);
  };
  for (const [path, manifest] of Object.entries(manifests)) {
    if (manifest === undefined) continue;
    const source = sourceForDataSourceManifestPath(path, resolvePluginId);
    const entry: DataSourceEntry = { manifestPath: path, manifest, source };
    const dir = entryDir(entry);
    const problem = problemFor(dir);
    if (source.kind === "plugin") {
      if (source.pluginId === "") {
        problem(
          "plugin directory has no readable tilecast.plugin.json identity",
        );
        continue;
      }
      const match =
        /(^|\/)plugins\/([^/]+)\/data-sources\/[^/]+\/tilecast\.datasource\.json$/.exec(
          path,
        );
      if (!match) {
        problem(
          `plugin Data Source must live at plugins/<plugin>/data-sources/<name>/tilecast.datasource.json (saw ${path})`,
        );
        continue;
      }
    } else if (!CORE_MANIFEST_PATTERN.test(path)) {
      problem(
        `core Data Source must live at data-sources/<name>/tilecast.datasource.json (saw ${path})`,
      );
      continue;
    }
    const sourceIssue = sourceProblem(source);
    if (sourceIssue) {
      problem(sourceIssue);
      continue;
    }
    sources.push({ dir, source });
  }
  return { sources, problems };
}
