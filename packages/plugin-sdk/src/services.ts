/**
 * The Player plugin service vocabulary of Plugin API 2.
 *
 * `player-services.json` at the package root is the canonical list. This
 * module mirrors it for TypeScript; `test/services.test.ts`, the Go SDK, and
 * Player Core each replay the JSON file, so no mirror can drift silently.
 *
 * A service is one narrow, independently versioned contract that a Player
 * offers to plugin contributions. A Player that reports a service at version
 * N implements every version from 1 to N. A change that cannot keep that
 * promise is a new service name, not a higher version.
 */

/** Where a service is implemented, and so which contribution may ask for it. */
export type PlayerServiceExecution = "runtime" | "native";

export interface PlayerServiceDefinition {
  readonly name: string;
  readonly version: number;
  readonly execution: PlayerServiceExecution;
  readonly description: string;
  /**
   * A runtime service that needs its host's help names the host capability
   * (`RuntimeCapabilitiesV1`) that must be true. The Runtime offers the
   * service only on such a host, so no Player reports it by default.
   */
  readonly hostCapability?: string;
}

/** The capability a Player reports when it hosts Plugin API 2 contributions. */
export const PLAYER_PLUGIN_HOST_CAPABILITY = "plugin.host";
export const PLAYER_PLUGIN_HOST_VERSION = 2;

export const PLAYER_SERVICES = [
  {
    name: "player.clock",
    version: 1,
    execution: "runtime",
    description:
      "Corrected server time, local and monotonic time, and plugin-owned timers.",
  },
  {
    name: "player.events",
    version: 1,
    execution: "runtime",
    description:
      "Ephemeral typed events between a plugin's native and Shared Runtime parts: declared names, bounded payloads, never state.",
    hostCapability: "pluginEvents",
  },
  {
    name: "player.media",
    version: 1,
    execution: "runtime",
    description:
      "Addresses for verified media variants that the plugin's current state entries declare.",
  },
  {
    name: "player.presentation.observe",
    version: 1,
    execution: "runtime",
    description:
      "Read-only observation of what owns the screen and which item is shown.",
  },
  {
    name: "player.presentation.provide",
    version: 1,
    execution: "runtime",
    description:
      "Registers a declared presentation provider. The host activates it for an external presentation that names it, and owns its visibility, lifecycle, and fallback.",
  },
  {
    name: "player.reference.signal",
    version: 1,
    execution: "native",
    description:
      "Reference service that qualifies the native service model: one typed read of a counter the platform owns. No product Player provides it.",
  },
  {
    name: "player.surface",
    version: 1,
    execution: "runtime",
    description:
      "Host-owned strip, corner, and overlay containers with claim arbitration and content-stage geometry.",
  },
] as const satisfies readonly PlayerServiceDefinition[];

/** `name@version`, for example `player.clock@1`. */
export const serviceReferencePattern =
  /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)@([1-9][0-9]{0,5})$/;

export interface ServiceReference {
  readonly name: string;
  readonly version: number;
}

export function parseServiceReference(value: string): ServiceReference | null {
  const match = serviceReferencePattern.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { name: match[1], version: Number(match[2]) };
}

export function formatServiceReference(reference: ServiceReference): string {
  return `${reference.name}@${reference.version}`;
}

/**
 * Runtime services the Shared Runtime always offers on a host that forwards
 * plugin state, as `[name, version]`. A service with a `hostCapability` is
 * added only by a host that sets that capability.
 */
export function sharedRuntimeServices(
  hostCapabilities: Readonly<Record<string, unknown>> = {},
): [string, number][] {
  return PLAYER_SERVICES.filter(
    (service: PlayerServiceDefinition) =>
      service.execution === "runtime" &&
      (service.hostCapability === undefined ||
        hostCapabilities[service.hostCapability] === true),
  ).map((service) => [service.name, service.version]);
}

export function playerService(
  name: string,
): PlayerServiceDefinition | undefined {
  return PLAYER_SERVICES.find((service) => service.name === name);
}

/**
 * Why a reference cannot be requested by a contribution of this execution
 * kind, or null when it can. Bundled plugins compile with the release, so an
 * unknown name or a version newer than the vocabulary is an authoring error.
 */
export function serviceReferenceProblem(
  value: string,
  execution: PlayerServiceExecution,
): string | null {
  const reference = parseServiceReference(value);
  if (!reference) return `${value} is not a name@version service reference`;
  const service = playerService(reference.name);
  if (!service) return `${reference.name} is not a Player plugin service`;
  if (reference.version > service.version) {
    return `${reference.name} has no version ${reference.version}; the newest is ${service.version}`;
  }
  if (service.execution !== execution) {
    return `${reference.name} is a ${service.execution} service; a ${execution} contribution cannot use it`;
  }
  return null;
}

/**
 * Whether a Player that reports `available` (capability name to highest
 * version) can satisfy one reference.
 */
export function serviceAvailable(
  available: Readonly<Record<string, number>>,
  value: string,
): boolean {
  const reference = parseServiceReference(value);
  if (!reference) return false;
  return (available[reference.name] ?? 0) >= reference.version;
}
