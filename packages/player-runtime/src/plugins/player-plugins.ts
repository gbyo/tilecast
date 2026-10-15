/**
 * Everything the Shared Runtime runs for plugins, composed once: the surface
 * host (v1 plugins, external surfaces, and `player.surface@1`), the Player
 * service registry, and the Player Plugin Host. `main.ts` and the plugin
 * integration tests build the same composition, so the tests exercise what
 * a Player runs.
 */
import type { RuntimeClock } from "../clock/scheduler";
import type { PluginsMessage } from "../host/contract";
import type { DiscoveredRuntimePlugin } from "./discovery";
import { RuntimeSurfaceHost } from "./host";
import type { DiscoveredPlayerPlugin } from "./player-discovery";
import { PlayerPluginHost } from "./player-host";
import {
  clockService,
  mediaService,
  PresentationObserver,
  surfaceService,
} from "./service-providers";
import { PlayerServiceRegistry } from "./services";

export interface PlayerPluginsOptions {
  clock: RuntimeClock;
  runtimePlugins: readonly DiscoveredRuntimePlugin[];
  playerPlugins: readonly DiscoveredPlayerPlugin[];
  animationScale: number;
  reducedMotion(): boolean;
  /** The host's media grant for plugin media. */
  mediaUrl(assetId: string, variantId: string): string;
  stage(): HTMLElement | null;
  diagnostic(pluginId: string, message: string): void;
  /** The host forwards Plugin API v2 `plugin_state` entries. */
  pluginState: boolean;
  externalPluginFrames?: boolean;
  document?: Document;
}

export class PlayerPlugins {
  readonly surfaces: RuntimeSurfaceHost;
  readonly services: PlayerServiceRegistry;
  readonly host: PlayerPluginHost;
  readonly presentation = new PresentationObserver();
  private clockOffsetMs = 0;

  constructor(options: PlayerPluginsOptions) {
    this.surfaces = new RuntimeSurfaceHost({
      clock: options.clock,
      plugins: options.runtimePlugins,
      animationScale: options.animationScale,
      reducedMotion: options.reducedMotion,
      externalPluginFrames: options.externalPluginFrames === true,
      mediaUrl: options.mediaUrl,
      stage: options.stage,
      diagnostic: options.diagnostic,
      ...(options.document ? { document: options.document } : {}),
    });
    this.services = new PlayerServiceRegistry([
      clockService({
        clock: options.clock,
        clockOffsetMs: () => this.clockOffsetMs,
      }),
      mediaService({ resolve: options.mediaUrl }),
      this.presentation.provider(),
      surfaceService({
        surfaces: this.surfaces,
        reducedMotion: options.reducedMotion,
        animationScale: options.animationScale,
      }),
    ]);
    this.host = new PlayerPluginHost({
      clock: options.clock,
      pluginState: options.pluginState,
      plugins: options.playerPlugins,
      services: this.services,
      diagnostic: options.diagnostic,
    });
  }

  /**
   * One complete plugins snapshot. v1 and external entries reach the surface
   * host; v2 state and declared v1 entries reach the Player Plugin Host.
   */
  receive(
    message: Pick<PluginsMessage, "plugins" | "clockOffsetMs" | "pluginFrames">,
  ): void {
    this.clockOffsetMs = Number.isFinite(message.clockOffsetMs)
      ? message.clockOffsetMs
      : 0;
    this.surfaces.setEntries(
      message.plugins,
      message.clockOffsetMs,
      message.pluginFrames,
    );
    this.host.setState(message.plugins, message.clockOffsetMs);
  }

  setAwake(awake: boolean): void {
    this.surfaces.setAwake(awake);
    this.host.setAwake(awake);
  }

  stop(): void {
    this.host.stop();
    this.surfaces.stop();
  }
}
