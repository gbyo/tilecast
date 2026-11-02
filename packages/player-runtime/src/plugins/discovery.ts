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
import type { AnyPlayerPluginDefinition } from "@tilecast/plugin-sdk/player";
import type {
  RuntimePluginDefinition,
  SurfaceSlot,
} from "@tilecast/plugin-sdk/runtime";
import {
  discoverPlayerPlugins,
  type PlayerDiscovery,
} from "./player-discovery";

export interface DiscoveredRuntimePlugin {
  /** Directory below plugins/. */
  dir: string;
  definition: RuntimePluginDefinition;
}

export interface RuntimeDiscovery {
  plugins: DiscoveredRuntimePlugin[];
  problems: string[];
}

export type ManifestModules = Record<string, PluginManifestInput>;
export type RuntimeModules = Record<
  string,
  { default?: RuntimePluginDefinition | AnyPlayerPluginDefinition }
>;

export function directoryOf(path: string): string {
  const match = /\/plugins\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a plugin path: ${path}`);
  return match[1];
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value));

/**
 * Pair Plugin API v1 manifests with runtime definitions. Every renderer lives
 * in its own plugin below plugins/; nothing central lists plugins or renders
 * for them. Plugin API v2 modules are left to `discoverPlayerPlugins`.
 */
export function discoverRuntimePlugins(
  manifests: ManifestModules,
  modules: RuntimeModules,
): RuntimeDiscovery {
  const problems: string[] = [];
  const byDir = new Map<string, PluginManifestInput>();
  for (const [path, manifest] of Object.entries(manifests)) {
    byDir.set(directoryOf(path), manifest);
  }
  const candidates: {
    dir: string;
    definition: RuntimePluginDefinition | undefined;
    manifest: Extract<PluginManifestInput, { apiVersion: 1 }> | undefined;
  }[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const dir = directoryOf(path);
    const manifest = byDir.get(dir);
    if (manifest?.apiVersion === 2) continue;
    candidates.push({
      dir,
      definition: module.default as RuntimePluginDefinition | undefined,
      manifest,
    });
  }

  const plugins: DiscoveredRuntimePlugin[] = [];
  const typeOwners = new Map<string, string>();
  for (const { dir, definition, manifest } of candidates) {
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
    if (runtime.entrypoint !== "./runtime/index.ts") {
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
    plugins.push({ dir, definition });
  }
  // One order everywhere: DOM order of containers, evaluation, diagnostics.
  plugins.sort((left, right) =>
    left.definition.id < right.definition.id ? -1 : 1,
  );
  return { plugins, problems };
}

const bundledManifests = import.meta.glob<PluginManifestInput>(
  "../../../../plugins/*/tilecast.plugin.json",
  { eager: true, import: "default" },
);
const bundledModules: RuntimeModules = import.meta.glob(
  "../../../../plugins/*/runtime/index.ts",
  { eager: true },
);

export const runtimeDiscovery: RuntimeDiscovery = discoverRuntimePlugins(
  bundledManifests,
  bundledModules,
);

export const playerDiscovery: PlayerDiscovery = discoverPlayerPlugins(
  bundledManifests,
  bundledModules,
  runtimeDiscovery.plugins.flatMap((plugin) => plugin.definition.manifestTypes),
);
