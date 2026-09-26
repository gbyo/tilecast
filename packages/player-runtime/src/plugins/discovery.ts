/// <reference types="vite/client" />
/**
 * Build-time discovery of shared-runtime plugins. Vite resolves both globs
 * when the runtime is built, so plugins/<name>/runtime/index.ts is all a
 * plugin adds; nothing is downloaded or loaded at run time.
 *
 * Each definition must agree with its manifest: identifier, tier, manifest
 * types, and surfaces. A plugin that does not agree is left out with a
 * diagnostic rather than allowed to destabilize the Player, and the runtime
 * tests fail on any diagnostic, so a mismatch never reaches a release.
 */
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import type {
  RuntimePluginDefinition,
  SurfaceSlot,
} from "@tilecast/plugin-sdk/runtime";
import { temporaryAdapters } from "./builtin";

export interface DiscoveredRuntimePlugin {
  /** Directory below plugins/. */
  dir: string;
  definition: RuntimePluginDefinition;
  /** Player hardware the manifest declares, for example "microphone". */
  hardware: readonly string[];
}

export interface RuntimeDiscovery {
  plugins: DiscoveredRuntimePlugin[];
  problems: string[];
}

type ManifestModules = Record<string, PluginManifestInput>;
type RuntimeModules = Record<string, { default?: RuntimePluginDefinition }>;

function directoryOf(path: string): string {
  const match = /\/plugins\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a plugin path: ${path}`);
  return match[1];
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value));

/**
 * Pair manifests with runtime definitions. `adapters` are MIGRATION ONLY:
 * renderers that still live in this package until their plugin moves. They
 * are checked against their plugin's manifest exactly like a discovered
 * module.
 */
export function discoverRuntimePlugins(
  manifests: ManifestModules,
  modules: RuntimeModules,
  adapters: readonly RuntimePluginDefinition[] = [],
): RuntimeDiscovery {
  const problems: string[] = [];
  const byDir = new Map<string, PluginManifestInput>();
  for (const [path, manifest] of Object.entries(manifests)) {
    byDir.set(directoryOf(path), manifest);
  }
  const candidates: {
    dir: string;
    definition: RuntimePluginDefinition | undefined;
    manifest: PluginManifestInput | undefined;
    adapter: boolean;
  }[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const dir = directoryOf(path);
    candidates.push({
      dir,
      definition: module.default,
      manifest: byDir.get(dir),
      adapter: false,
    });
  }
  for (const definition of adapters) {
    const entry = [...byDir.entries()].find(
      ([, manifest]) => manifest.id === definition.id,
    );
    candidates.push({
      dir: entry?.[0] ?? definition.id.replaceAll("_", "-"),
      definition,
      manifest: entry?.[1],
      adapter: true,
    });
  }

  const plugins: DiscoveredRuntimePlugin[] = [];
  const typeOwners = new Map<string, string>();
  for (const { dir, definition, manifest, adapter } of candidates) {
    const problem = (message: string) =>
      problems.push(`plugins/${dir}: ${message}`);
    const runtime = manifest?.runtime;
    if (!definition || typeof definition.create !== "function") {
      problem("runtime/index.ts must default-export defineRuntimePlugin(...)");
      continue;
    }
    if (!manifest || !runtime) {
      problem("has a runtime definition but its manifest declares no runtime");
      continue;
    }
    if (adapter && runtime.entrypoint) {
      problem(
        "declares runtime/index.ts; remove its temporary adapter from the runtime package",
      );
      continue;
    }
    if (!adapter && runtime.entrypoint !== "./runtime/index.ts") {
      problem("has runtime/index.ts but the manifest does not declare it");
      continue;
    }
    const surfaces: readonly SurfaceSlot[] = runtime.surfaces ?? [];
    const mismatch = [
      definition.id !== manifest.id && `id ${definition.id} ≠ ${manifest.id}`,
      definition.tier !== runtime.tier &&
        `tier ${definition.tier} ≠ ${runtime.tier}`,
      !sameSet(definition.manifestTypes, runtime.manifestTypes) &&
        "manifestTypes differ from runtime.manifestTypes",
      !sameSet(definition.surfaces, surfaces) &&
        "surfaces differ from runtime.surfaces",
    ].filter(Boolean);
    if (mismatch.length > 0) {
      problem(`definition does not match its manifest: ${mismatch.join("; ")}`);
      continue;
    }
    const taken = definition.manifestTypes.find((type) => typeOwners.has(type));
    if (taken) {
      problem(
        `manifest type ${taken} is also rendered by ${typeOwners.get(taken)}`,
      );
      continue;
    }
    for (const type of definition.manifestTypes) {
      typeOwners.set(type, definition.id);
    }
    plugins.push({
      dir,
      definition,
      hardware: manifest.capabilities?.hardware ?? [],
    });
  }
  // One order everywhere: DOM order of containers, evaluation, diagnostics.
  plugins.sort((left, right) =>
    left.definition.id < right.definition.id ? -1 : 1,
  );
  return { plugins, problems };
}

export const runtimeDiscovery: RuntimeDiscovery = discoverRuntimePlugins(
  import.meta.glob<PluginManifestInput>(
    "../../../../plugins/*/tilecast.plugin.json",
    { eager: true, import: "default" },
  ),
  import.meta.glob<{ default?: RuntimePluginDefinition }>(
    "../../../../plugins/*/runtime/index.ts",
    { eager: true },
  ),
  temporaryAdapters,
);
