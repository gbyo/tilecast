/**
 * The Player Plugin Host: the generic Shared Runtime host for Plugin API v2.
 *
 * It owns plugin lifecycle and state routing, and it binds the services a
 * plugin asks for from the service registry. It has no evaluation loop: a
 * plugin hears about its own state, sleep and wake, and service changes,
 * and asks the clock service for time-based behavior. Surfaces are one
 * service, so a plugin that draws nothing never touches the surface host.
 *
 * A plugin is active while the Server sends state for it and every required
 * service is available. A plugin that throws anywhere (activation, a hook,
 * or a callback a service makes) is disposed and stays failed for the life
 * of the document. Other plugins and playback never see the error.
 *
 * The host never reads a plugin identifier to decide behavior, and it never
 * touches presentation: plugin state arrives on its own channel, so a state
 * change cannot restart a playlist, a video, or a Layout.
 */
import type {
  PlayerPluginInstance,
  PlayerServiceId,
  PlayerStateEntry,
} from "@tilecast/plugin-sdk/player";
import {
  TimerGroup,
  type RuntimeClock,
  type TimerHandle,
} from "../clock/scheduler";
import type { DiscoveredPlayerPlugin } from "./player-discovery";
import type { PlayerServiceRegistry, ServiceBinding } from "./services";
import {
  isPluginStateEntry,
  MAX_STATE_ENTRIES,
  parseStateEntry,
  parseV1Entry,
  type RoutedState,
} from "./state";

const MAX_DIAGNOSTICS = 100;

export type PlayerPluginStatus =
  /** No state for this plugin on this Player. */
  | "inactive"
  /** State exists, but a required service is missing. */
  | "unsupported"
  | "active"
  /** It threw; it stays disposed until the Runtime reloads. */
  | "failed";

export interface PlayerPluginHostOptions {
  clock: RuntimeClock;
  /**
   * The host forwards Plugin API v2 `plugin_state` entries. Without it the
   * Player Plugin Host still runs plugins from their declared v1 entries.
   */
  pluginState: boolean;
  plugins: readonly DiscoveredPlayerPlugin[];
  services: PlayerServiceRegistry;
  diagnostic(pluginId: string, message: string): void;
}

export interface PlayerPluginHostDescription {
  plugins: {
    id: string;
    status: PlayerPluginStatus;
    /** Required services this Player lacks. */
    missing: string[];
    /** Optional services this Player lacks. */
    degraded: string[];
    text: string;
  }[];
  diagnostics: string[];
}

interface Hosted {
  readonly plugin: DiscoveredPlayerPlugin;
  status: PlayerPluginStatus;
  entries: readonly PlayerStateEntry[];
  /** JSON of the last entries delivered, to deliver only real changes. */
  delivered: string;
  instance: PlayerPluginInstance | null;
  bindings: Map<PlayerServiceId, ServiceBinding>;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class PlayerPluginHost {
  private readonly hosted: Hosted[];
  private readonly timers: TimerGroup;
  private routed: RoutedState[] = [];
  private clockOffsetMs = 0;
  private awake = true;
  private expiry: TimerHandle | null = null;
  private stopped = false;
  private readonly diagnostics: string[] = [];
  private readonly unsubscribe: () => void;
  /** v1 entry type to the v2 plugin that consumes it. */
  private readonly v1Owners = new Map<
    string,
    { id: string; definitionVersion: number }
  >();

  constructor(private readonly options: PlayerPluginHostOptions) {
    for (const { declaration } of options.plugins) {
      for (const type of declaration.v1Types) {
        this.v1Owners.set(type, {
          id: declaration.id,
          definitionVersion: declaration.definitionVersion,
        });
      }
    }
    this.timers = new TimerGroup(options.clock);
    this.hosted = options.plugins.map((plugin) => ({
      plugin,
      status: "inactive",
      entries: [],
      delivered: "[]",
      instance: null,
      bindings: new Map(),
    }));
    this.unsubscribe = options.services.subscribe(() => this.servicesChanged());
  }

  /** Corrected server time used for state expiry. */
  now(): number {
    return this.options.clock.wallNow() + this.clockOffsetMs;
  }

  /**
   * A complete plugins snapshot arrived. The host reads `plugin_state`
   * entries when the host forwards them, and the v1 entry types that a v2
   * plugin declares in `v1ManifestTypes`. Every other entry belongs to the
   * surface host.
   */
  setState(entries: readonly unknown[], clockOffsetMs: number): void {
    if (this.stopped) return;
    this.clockOffsetMs = Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0;
    const now = this.now();
    const routed: RoutedState[] = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(entries) ? entries : []) {
      let parsed: RoutedState | string | null = null;
      if (isPluginStateEntry(value)) {
        if (!this.options.pluginState) continue;
        parsed = parseStateEntry(value, now);
      } else {
        const type = (value as { type?: unknown } | null)?.type;
        const owner =
          typeof type === "string" ? this.v1Owners.get(type) : undefined;
        if (!owner) continue;
        parsed = parseV1Entry(value, owner.id, owner.definitionVersion);
      }
      if (typeof parsed === "string") {
        if (parsed !== "expired") this.report("plugin_state", parsed);
        continue;
      }
      const key = `${parsed.plugin}/${parsed.entry.id}`;
      if (seen.has(key)) {
        this.report(parsed.plugin, `duplicate state ${parsed.entry.id}`);
        continue;
      }
      if (routed.length >= MAX_STATE_ENTRIES) {
        this.report("plugin_state", "too many entries");
        break;
      }
      seen.add(key);
      routed.push(parsed);
    }
    this.routed = routed;
    this.reconcile();
  }

  /** The Player went to sleep (outside active hours) or woke up. */
  setAwake(awake: boolean): void {
    if (this.stopped || awake === this.awake) return;
    this.awake = awake;
    for (const hosted of this.hosted) {
      if (hosted.status !== "active") continue;
      this.call(hosted, "awakeChanged", (instance) =>
        instance.awakeChanged?.(awake),
      );
    }
  }

  describe(): PlayerPluginHostDescription {
    const available = this.options.services;
    return {
      plugins: this.hosted.map((hosted) => {
        const { declaration } = hosted.plugin;
        let text = "";
        if (hosted.status === "active") {
          try {
            text = hosted.instance?.describe?.() ?? "";
          } catch (error) {
            this.report(declaration.id, `describe failed: ${errorText(error)}`);
          }
        }
        return {
          id: declaration.id,
          status: hosted.status,
          missing: declaration.required.filter((id) => !available.provider(id)),
          degraded: declaration.optional.filter(
            (id) => !available.provider(id),
          ),
          text,
        };
      }),
      diagnostics: [...this.diagnostics],
    };
  }

  /** Dispose every plugin. The document is going away. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    this.timers.cancelAll();
    for (const hosted of this.hosted) this.deactivate(hosted, "inactive");
  }

  // ------------------------------------------------------------ lifecycle

  private reconcile(): void {
    const now = this.now();
    for (const hosted of this.hosted) {
      const { declaration } = hosted.plugin;
      const entries = this.routed
        .filter(
          (routed) =>
            routed.plugin === declaration.id &&
            (routed.validUntilMs === null || routed.validUntilMs > now) &&
            (routed.v1
              ? declaration.v1Types.has(routed.entry.type)
              : declaration.state.has(
                  `${routed.entry.type}@${routed.entry.version}`,
                )),
        )
        .map((routed) => routed.entry);
      hosted.entries = entries;
      if (hosted.status === "failed") continue;
      if (entries.length === 0) {
        this.deactivate(hosted, "inactive");
        continue;
      }
      if (!this.supported(hosted)) {
        if (hosted.status === "active") {
          this.report(
            declaration.id,
            "a required service is no longer available",
          );
        }
        this.deactivate(hosted, "unsupported");
        continue;
      }
      if (hosted.status !== "active") this.activate(hosted);
      else this.deliver(hosted);
    }
    this.scheduleExpiry();
  }

  private supported(hosted: Hosted): boolean {
    return hosted.plugin.declaration.required.every((id) =>
      this.options.services.provider(id),
    );
  }

  private activate(hosted: Hosted): void {
    const { declaration, definition } = hosted.plugin;
    for (const id of [...declaration.required, ...declaration.optional]) {
      this.bind(hosted, id);
    }
    const bindings = hosted.bindings;
    const services = {} as Record<string, unknown>;
    for (const id of [...declaration.required, ...declaration.optional]) {
      Object.defineProperty(services, id, {
        enumerable: true,
        get: () => bindings.get(id)?.api ?? null,
      });
    }
    hosted.status = "active";
    hosted.delivered = "[]";
    try {
      const instance = definition.activate({
        pluginId: declaration.id,
        services: Object.freeze(services) as never,
        awake: () => this.awake,
      });
      hosted.instance = instance ?? {};
    } catch (error) {
      this.fail(hosted, `activate failed: ${errorText(error)}`);
      return;
    }
    this.deliver(hosted);
  }

  private deliver(hosted: Hosted): void {
    const encoded = JSON.stringify(hosted.entries);
    if (encoded === hosted.delivered) return;
    hosted.delivered = encoded;
    const entries = hosted.entries;
    this.call(hosted, "stateChanged", (instance) =>
      instance.stateChanged?.(entries),
    );
  }

  private deactivate(hosted: Hosted, status: PlayerPluginStatus): void {
    const instance = hosted.instance;
    hosted.instance = null;
    if (instance?.dispose) {
      try {
        instance.dispose();
      } catch (error) {
        this.report(
          hosted.plugin.declaration.id,
          `dispose failed: ${errorText(error)}`,
        );
      }
    }
    for (const binding of hosted.bindings.values()) {
      try {
        binding.dispose();
      } catch (error) {
        this.report(
          hosted.plugin.declaration.id,
          `service release failed: ${errorText(error)}`,
        );
      }
    }
    hosted.bindings.clear();
    hosted.delivered = "[]";
    if (hosted.status !== "failed") hosted.status = status;
  }

  private fail(hosted: Hosted, message: string): void {
    this.report(hosted.plugin.declaration.id, message);
    this.deactivate(hosted, "failed");
    hosted.status = "failed";
  }

  /** Call one hook; a throw fails only this plugin. */
  private call(
    hosted: Hosted,
    hook: string,
    run: (instance: PlayerPluginInstance) => void,
  ): void {
    if (hosted.status !== "active" || !hosted.instance) return;
    try {
      run(hosted.instance);
    } catch (error) {
      this.fail(hosted, `${hook} failed: ${errorText(error)}`);
    }
  }

  // ------------------------------------------------------------ services

  private bind(hosted: Hosted, id: PlayerServiceId): void {
    const provider = this.options.services.provider(id);
    if (!provider || hosted.bindings.has(id)) return;
    const pluginId = hosted.plugin.declaration.id;
    try {
      hosted.bindings.set(
        id,
        provider.bind({
          pluginId,
          declaration: hosted.plugin.declaration,
          entries: () => hosted.entries,
          report: (message) => this.report(pluginId, message),
          guard: (callback) => {
            if (hosted.status !== "active") return;
            try {
              callback();
            } catch (error) {
              this.fail(hosted, `callback failed: ${errorText(error)}`);
            }
          },
        }),
      );
    } catch (error) {
      this.report(pluginId, `${id} could not bind: ${errorText(error)}`);
    }
  }

  /**
   * A service appeared or went away. Required services decide activation;
   * optional ones are rebound and the plugin hears `servicesChanged`.
   */
  private servicesChanged(): void {
    if (this.stopped) return;
    for (const hosted of this.hosted) {
      if (hosted.status !== "active") continue;
      if (!this.supported(hosted)) continue; // reconcile deactivates it
      let changed = false;
      for (const id of hosted.plugin.declaration.optional) {
        const provider = this.options.services.provider(id);
        const binding = hosted.bindings.get(id);
        if (!provider && binding) {
          binding.dispose();
          hosted.bindings.delete(id);
          changed = true;
        } else if (provider && !binding) {
          this.bind(hosted, id);
          changed = true;
        }
      }
      if (changed) {
        this.call(hosted, "servicesChanged", (instance) =>
          instance.servicesChanged?.(),
        );
      }
    }
    this.reconcile();
  }

  // ------------------------------------------------------------ expiry

  private scheduleExpiry(): void {
    this.expiry?.cancel();
    this.expiry = null;
    const now = this.now();
    let next = Infinity;
    for (const routed of this.routed) {
      if (routed.validUntilMs !== null && routed.validUntilMs > now) {
        next = Math.min(next, routed.validUntilMs - now);
      }
    }
    if (Number.isFinite(next)) {
      this.expiry = this.timers.after(next, () => {
        this.expiry = null;
        this.reconcile();
      });
    }
  }

  private report(pluginId: string, message: string): void {
    const line = `${pluginId}: ${message}`;
    if (this.diagnostics.includes(line)) return;
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) this.diagnostics.shift();
    this.diagnostics.push(line);
    this.options.diagnostic(pluginId, message);
  }
}
