/**
 * Build-time discovery of Plugin API v2 Player plugins. It reads the same
 * Vite globs as the v1 discovery, so a v2 plugin adds only its own
 * directory. A definition that does not agree with its manifest is left out
 * with a diagnostic; the runtime tests fail on any diagnostic.
 */
import type {
  PluginManifestInput,
  SurfaceContribution,
} from "@tilecast/plugin-sdk/manifest";
import type {
  AnyPlayerPluginDefinition,
  PlayerServiceId,
} from "@tilecast/plugin-sdk/player";
import { parseServiceReference } from "@tilecast/plugin-sdk/services";
import type { ManifestModules, RuntimeModules } from "./discovery";

type ManifestV2Input = Extract<PluginManifestInput, { apiVersion: 2 }>;

/** What the host needs from a v2 manifest, normalized. */
export interface PlayerPluginDeclaration {
  id: string;
  definitionVersion: number;
  /** Accepted `type@version` state keys. */
  state: ReadonlySet<string>;
  required: readonly PlayerServiceId[];
  optional: readonly PlayerServiceId[];
  surfaces: readonly SurfaceContribution[];
  /** Declared `player.events`, normalized. */
  events: readonly {
    name: string;
    version: number;
    source: "native" | "runtime";
  }[];
  /** Declared presentation provider ids. */
  providers: readonly string[];
}

export interface DiscoveredPlayerPlugin {
  dir: string;
  declaration: PlayerPluginDeclaration;
  definition: AnyPlayerPluginDefinition;
}

export interface PlayerDiscovery {
  plugins: DiscoveredPlayerPlugin[];
  problems: string[];
}

function directoryOf(path: string): string {
  const match = /\/plugins\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a plugin path: ${path}`);
  return match[1];
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value));

/** Normalize a v2 manifest's Shared Runtime contribution. */
export function playerDeclaration(
  manifest: ManifestV2Input,
): PlayerPluginDeclaration | null {
  const runtime = manifest.player?.runtime;
  if (!manifest.player || !runtime) return null;
  return {
    id: manifest.id,
    definitionVersion: manifest.definitionVersion,
    state: new Set(
      manifest.player.state.map((state) => `${state.type}@${state.version}`),
    ),
    required: [...(runtime.services?.required ?? [])] as PlayerServiceId[],
    optional: [...(runtime.services?.optional ?? [])] as PlayerServiceId[],
    surfaces: (runtime.surfaces ?? []).map((surface) => ({
      id: surface.id,
      slots: [...surface.slots],
      tier: surface.tier,
    })),
    events: (manifest.player.events ?? []).map((event) => ({
      name: event.name,
      version: event.version,
      source: event.source,
    })),
    providers: (runtime.providers ?? []).map((provider) => provider.id),
  };
}

/**
 * Pair v2 manifests with their `definePlayerPlugin` modules. `v1Types` are
 * the manifest types v1 plugins already own; state types share their
 * namespace.
 */
export function discoverPlayerPlugins(
  manifests: ManifestModules,
  modules: RuntimeModules,
  v1Types: readonly string[] = [],
): PlayerDiscovery {
  const problems: string[] = [];
  const byDir = new Map<string, PluginManifestInput>();
  for (const [path, manifest] of Object.entries(manifests)) {
    byDir.set(directoryOf(path), manifest);
  }
  const owners = new Map<string, string>(
    v1Types.map((type) => [type, "a Plugin API 1 plugin"]),
  );
  const plugins: DiscoveredPlayerPlugin[] = [];
  const withModule = new Set<string>();
  for (const [path, module] of Object.entries(modules)) {
    const dir = directoryOf(path);
    const manifest = byDir.get(dir);
    if (manifest?.apiVersion !== 2) continue;
    withModule.add(dir);
    const problem = (message: string) =>
      problems.push(`plugins/${dir}: ${message}`);
    const definition = module.default as AnyPlayerPluginDefinition | undefined;
    if (!definition || typeof definition.activate !== "function") {
      problem("runtime/index.ts must default-export definePlayerPlugin(...)");
      continue;
    }
    const declaration = playerDeclaration(manifest);
    if (!declaration) {
      problem(
        "has runtime/index.ts but its manifest declares no player.runtime",
      );
      continue;
    }
    const mismatch = [
      definition.id !== manifest.id && `id ${definition.id} ≠ ${manifest.id}`,
      !sameSet(definition.services.required, declaration.required) &&
        "required services differ from player.runtime.services.required",
      !sameSet(definition.services.optional, declaration.optional) &&
        "optional services differ from player.runtime.services.optional",
    ].filter(Boolean);
    if (mismatch.length > 0) {
      problem(`definition does not match its manifest: ${mismatch.join("; ")}`);
      continue;
    }
    const types = [...declaration.state].map((key) => key.split("@")[0]!);
    const taken = types.find(
      (type) => owners.has(type) && owners.get(type) !== declaration.id,
    );
    if (taken) {
      problem(`state type ${taken} is also owned by ${owners.get(taken)}`);
      continue;
    }
    for (const type of types) owners.set(type, declaration.id);
    plugins.push({ dir, declaration, definition });
  }
  for (const [dir, manifest] of byDir) {
    if (
      manifest.apiVersion === 2 &&
      manifest.player?.runtime &&
      !withModule.has(dir)
    ) {
      problems.push(
        `plugins/${dir}: declares player.runtime but has no runtime/index.ts`,
      );
    }
  }
  plugins.sort((left, right) =>
    left.declaration.id < right.declaration.id ? -1 : 1,
  );
  return { plugins, problems };
}

/** The service names a declaration requests, without versions. */
export function serviceNames(ids: readonly string[]): string[] {
  return ids.map((id) => parseServiceReference(id)?.name ?? id);
}
