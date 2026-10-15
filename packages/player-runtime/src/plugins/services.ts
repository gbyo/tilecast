/**
 * The Player service registry of the Player Plugin Host.
 *
 * Each service is a small provider with one name and one version. A
 * provider binds a narrow API to one plugin and releases everything it gave
 * that plugin when the binding is disposed. The registry never interprets a
 * plugin's identity; it answers which services exist and binds them.
 *
 * Adding a service means adding a provider and a vocabulary entry in
 * `packages/plugin-sdk/player-services.json`. Neither the host nor any other
 * provider changes, and no plugin receives an API it did not request.
 */
import type { PlayerStateEntry } from "@tilecast/plugin-sdk/player";
import type { PlayerPluginDeclaration } from "./player-discovery";

/** What a provider knows about the plugin it binds to. */
export interface ServiceBindingContext {
  readonly pluginId: string;
  readonly declaration: PlayerPluginDeclaration;
  /** The plugin's current state entries. */
  entries(): readonly PlayerStateEntry[];
  /** Record a diagnostic for this plugin. */
  report(message: string): void;
  /**
   * Run plugin code that a service calls back (a timer, a grant, a
   * listener). A throw fails the plugin; it never escapes into the host.
   */
  guard(callback: () => void): void;
}

export interface ServiceBinding<Api = unknown> {
  readonly api: Api;
  dispose(): void;
}

export interface PlayerServiceProvider<Api = unknown> {
  readonly name: string;
  /** The highest version implemented; every lower version is implemented. */
  readonly version: number;
  bind(context: ServiceBindingContext): ServiceBinding<Api>;
}

export class PlayerServiceRegistry {
  private readonly providers = new Map<string, PlayerServiceProvider>();
  private readonly listeners = new Set<() => void>();

  constructor(providers: readonly PlayerServiceProvider[] = []) {
    for (const provider of providers)
      this.providers.set(provider.name, provider);
  }

  /** Offer a service, or replace an earlier provider of the same name. */
  provide(provider: PlayerServiceProvider): void {
    this.providers.set(provider.name, provider);
    this.changed();
  }

  /** A service went away (for example, a host capability was lost). */
  withdraw(name: string): void {
    if (this.providers.delete(name)) this.changed();
  }

  /** The provider that satisfies `name@version`, if any. */
  provider(reference: string): PlayerServiceProvider | null {
    const at = reference.lastIndexOf("@");
    const name = reference.slice(0, at);
    const version = Number(reference.slice(at + 1));
    const provider = this.providers.get(name);
    return provider && Number.isInteger(version) && provider.version >= version
      ? provider
      : null;
  }

  /** Capability report: service name to highest version. */
  available(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, provider] of [...this.providers].sort(([a], [b]) =>
      a < b ? -1 : 1,
    ))
      out[name] = provider.version;
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
