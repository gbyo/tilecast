/**
 * Build-time plugin discovery for Studio. Vite resolves both globs when the
 * bundle is built, so adding plugins/<name>/studio/index.tsx is all a plugin
 * does to appear here; no runtime loading and no third-party code.
 */
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import type { StudioPluginDefinition } from "./kit";

export interface DiscoveredStudioPlugin {
  id: string;
  /** Directory below plugins/. */
  dir: string;
  name: string;
  /** The manifest's studio.route, for example "/plugins/countdown-bar". */
  route: string;
  definition: StudioPluginDefinition;
}

type ManifestModules = Record<string, PluginManifestInput>;
type StudioModules = Record<string, { default: StudioPluginDefinition }>;

function directoryOf(path: string): string {
  const match = /\/plugins\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a plugin path: ${path}`);
  return match[1];
}

/**
 * Pair each manifest with its Studio entry point. A mismatch is a build
 * defect that `npm run plugins:check` reports first; here it fails loudly
 * rather than rendering a plugin under the wrong identity.
 */
export function discoverStudioPlugins(
  manifests: ManifestModules,
  modules: StudioModules,
): DiscoveredStudioPlugin[] {
  const byDir = new Map(
    Object.entries(manifests).map(([path, manifest]) => [
      directoryOf(path),
      manifest,
    ]),
  );
  const out: DiscoveredStudioPlugin[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const dir = directoryOf(path);
    const manifest = byDir.get(dir);
    const definition = module.default;
    if (!manifest?.studio) {
      throw new Error(
        `plugins/${dir} has a Studio entry point but its manifest declares no studio route`,
      );
    }
    if (definition?.id !== manifest.id) {
      throw new Error(
        `plugins/${dir}/studio/index.tsx must export defineStudioPlugin({ id: "${manifest.id}" })`,
      );
    }
    out.push({
      id: manifest.id,
      dir,
      name: manifest.name,
      route: manifest.studio.route,
      definition,
    });
  }
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

export const studioPlugins = discoverStudioPlugins(
  import.meta.glob<PluginManifestInput>(
    "../../../../plugins/*/tilecast.plugin.json",
    {
      eager: true,
      import: "default",
    },
  ),
  import.meta.glob<{ default: StudioPluginDefinition }>(
    "../../../../plugins/*/studio/index.tsx",
    {
      eager: true,
    },
  ),
);

export function studioPluginById(
  id: string,
): DiscoveredStudioPlugin | undefined {
  return studioPlugins.find((plugin) => plugin.id === id);
}

/** True when this Studio bundle has a page for a plugin's management route. */
export function hasStudioRoute(path: string): boolean {
  return studioPlugins.some((plugin) => plugin.route === path);
}
