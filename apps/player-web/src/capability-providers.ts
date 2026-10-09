import registry from "../../../packages/player-contracts/player-capabilities.json";

/** One reported capability: the registry version and serving provider. */
export interface PlayerCapabilityReport {
  version: number;
  provider: string;
}

/** The generic capability status: unsupported capabilities are absent. */
export type PlayerCapabilitySet = Record<string, PlayerCapabilityReport>;

/** A bounded, typed provider answer. Never a raw exception or handle. */
export interface TypedCapabilityResult {
  success: boolean;
  code: string;
  message?: string;
}

/**
 * One source of Player capabilities. Browser-native providers live here;
 * the optional Browser Companion contributes additional providers over
 * its bridge. Providers report what they actually support: describe()
 * answers the current truth, and the heartbeat repeats it, so a
 * disconnected provider disappears promptly.
 */
export interface BrowserCapabilityProvider {
  /** Stable diagnostic identity, for example "companion". */
  readonly id: string;
  describe(): PlayerCapabilitySet;
  invoke(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<TypedCapabilityResult>;
}

interface CommandRoute {
  operation: string;
  capability: string;
  /** Discriminator fields the server strips; the host re-adds them. */
  when: Record<string, unknown>;
}

interface RegistryOperation {
  operation: string;
  commands?: { when?: Record<string, unknown>; command?: unknown }[];
}

interface RegistryCapability {
  id?: unknown;
  operations?: RegistryOperation[];
}

/** Parses the bundled registry into command routes. Total: malformed data yields no routes. */
function parseRegistry(value: unknown): Map<string, CommandRoute> {
  const routes = new Map<string, CommandRoute>();
  const root = value as { capabilities?: RegistryCapability[] } | null;
  if (!root || !Array.isArray(root.capabilities)) return routes;
  for (const capability of root.capabilities) {
    if (typeof capability?.id !== "string") continue;
    if (!Array.isArray(capability.operations)) continue;
    for (const entry of capability.operations) {
      if (typeof entry?.operation !== "string") continue;
      if (!Array.isArray(entry.commands)) continue;
      for (const row of entry.commands) {
        if (typeof row?.command !== "string") continue;
        if (routes.has(row.command)) continue;
        const when =
          row.when && typeof row.when === "object" && !Array.isArray(row.when)
            ? (row.when as Record<string, unknown>)
            : {};
        routes.set(row.command, {
          operation: entry.operation,
          capability: capability.id,
          when,
        });
      }
    }
  }
  return routes;
}

const COMMAND_ROUTES = parseRegistry(registry);

/** Stable encoding for change tracking. */
export function encodeCapabilitySet(set: PlayerCapabilitySet): string {
  return JSON.stringify(
    Object.keys(set)
      .sort()
      .map((id) => [id, set[id]?.version ?? 0, set[id]?.provider ?? ""]),
  );
}

/**
 * Aggregates capability providers. First registered wins per capability:
 * providers own disjoint capabilities in practice, and a deterministic
 * rule beats a silent overwrite. The registry never invents entries:
 * with no providers it describes the empty set, and routing an
 * unprovided command answers undefined so the caller reports the
 * standard unsupported result.
 */
export class CapabilityProviderRegistry {
  private readonly providers = new Map<string, BrowserCapabilityProvider>();

  add(provider: BrowserCapabilityProvider): void {
    this.providers.set(provider.id, provider);
  }

  remove(id: string): boolean {
    return this.providers.delete(id);
  }

  get size(): number {
    return this.providers.size;
  }

  describe(): PlayerCapabilitySet {
    const merged: PlayerCapabilitySet = {};
    for (const provider of this.providers.values()) {
      let reported: PlayerCapabilitySet;
      try {
        reported = provider.describe();
      } catch {
        continue;
      }
      if (!reported || typeof reported !== "object") continue;
      for (const [id, report] of Object.entries(reported)) {
        if (merged[id] !== undefined) continue;
        if (
          typeof report?.version !== "number" ||
          !Number.isInteger(report.version) ||
          typeof report?.provider !== "string" ||
          report.provider === ""
        ) {
          continue;
        }
        merged[id] = { version: report.version, provider: report.provider };
      }
    }
    return merged;
  }

  /** True when a registered provider currently describes the capability. */
  provides(capability: string, version: number): boolean {
    return this.describe()[capability]?.version === version;
  }

  /**
   * Routes one persistent Player command to its provider. Answers
   * undefined when no route or provider covers the command; otherwise
   * rebuilds the operation input (payload plus the discriminators the
   * server strips when it queues the command) and invokes the provider
   * that describes the capability.
   */
  async invokeCommand(
    type: string,
    payload: Record<string, unknown> | null,
  ): Promise<TypedCapabilityResult | undefined> {
    const route = COMMAND_ROUTES.get(type);
    if (!route) return undefined;
    const described = this.describe();
    if (described[route.capability] === undefined) return undefined;
    const input: Record<string, unknown> = {
      ...(payload ?? {}),
      ...route.when,
    };
    for (const provider of this.providers.values()) {
      let reported: PlayerCapabilitySet;
      try {
        reported = provider.describe();
      } catch {
        continue;
      }
      if (!reported || typeof reported !== "object") continue;
      if (reported[route.capability] === undefined) continue;
      try {
        const result = await provider.invoke(route.operation, input);
        if (
          !result ||
          typeof result.success !== "boolean" ||
          typeof result.code !== "string"
        ) {
          return {
            success: false,
            code: "provider_bad_result",
            message: "The provider answered outside its result shape.",
          };
        }
        return {
          success: result.success,
          code: result.code.slice(0, 80),
          ...(typeof result.message === "string" && result.message !== ""
            ? { message: result.message.slice(0, 240) }
            : {}),
        };
      } catch (error) {
        return {
          success: false,
          code: "provider_failed",
          message:
            error instanceof Error
              ? error.message.slice(0, 240)
              : "The provider failed.",
        };
      }
    }
    return undefined;
  }
}
