/**
 * The Shared Runtime half of Plugin API v2: Player plugins.
 *
 * A v2 plugin's `runtime/index.ts` default-exports `definePlayerPlugin(...)`.
 * The Player Plugin Host in the Shared Runtime discovers it when the Runtime
 * is built. Nothing is loaded at run time.
 *
 * A Player plugin is not a renderer. It is activated while the Server sends
 * state for it, it reacts to events, and it asks for the narrow services it
 * needs. Drawing is one service (`player.surface@1`) among others. The host
 * owns lifecycle, state routing, service binding, failure isolation, and
 * disposal. Every service binding belongs to one plugin and is released with
 * it, so a plugin never reads host globals, never touches the content stage,
 * and never outlives its state.
 */
import type {
  RuntimePluginClock,
  SurfaceClaim,
  SurfaceGrant,
  SurfaceSlot,
  TimerHandle,
} from "./runtime.ts";

export type { SurfaceClaim, SurfaceGrant, SurfaceSlot, TimerHandle };

/** A verified media variant a state entry declares. */
export interface PlayerMediaRef {
  readonly assetId: string;
  readonly variantId: string;
}

/**
 * One current `plugin_state` entry for the plugin, already validated and
 * filtered to the state types and versions its manifest declares.
 */
export interface PlayerStateEntry<State = Record<string, unknown>> {
  /** Stable identity of the plugin's instance, chosen by the Server plugin. */
  readonly id: string;
  /** A `player.state` type the manifest declares. */
  readonly type: string;
  readonly version: number;
  readonly state: State;
  readonly media: readonly PlayerMediaRef[];
  /** Corrected-clock expiry; the host removes the entry when it passes. */
  readonly validUntil: string | null;
}

// ------------------------------------------------------------ services

/** `player.clock@1`. Timers belong to the plugin and end with it. */
export type PlayerClockService = RuntimePluginClock;

/** `player.media@1`. */
export interface PlayerMediaService {
  /**
   * The Player address of a variant that one of the plugin's current state
   * entries declares, or null. Anything else is refused, so a plugin can
   * only show media that the Server delivered and the Player verified.
   */
  url(ref: PlayerMediaRef): string | null;
}

/** What owns the screen, as `player.presentation.observe@1` reports it. */
export interface PresentationObservation {
  /**
   * `playing`: presentation content; `sleep`: outside active hours;
   * `status`: a Tilecast status surface (setup, pairing, offline...);
   * `waiting`: nothing has been presented yet.
   */
  readonly mode: "playing" | "sleep" | "status" | "waiting";
  /** The item on screen while playing, or null. */
  readonly item: {
    readonly id: string;
    /** The item kind, for example `image`, `video`, `widget`, or `layout`. */
    readonly kind: string;
    /** Increases for every new occurrence, including a repeat of one item. */
    readonly occurrence: number;
    /** True when the foreground item may play sound. */
    readonly audible: boolean;
  } | null;
}

/** `player.presentation.observe@1`: read-only, never a control channel. */
export interface PresentationObserveService {
  current(): PresentationObservation;
  /**
   * Called after each change. The listener is not called for the current
   * value; read `current()` first. Returns an unsubscribe function.
   */
  subscribe(
    listener: (observation: PresentationObservation) => void,
  ): () => void;
}

/** Host decision for one surface contribution. */
export type PlayerSurfaceGrant = SurfaceGrant;

/**
 * One claim of a surface contribution. Priority orders claims within the
 * contribution's declared tier; the claim cannot name a tier.
 */
export type PlayerSurfaceClaim = SurfaceClaim;

export interface PlayerSurfaceHandle {
  /** The host-owned container of a declared slot. It persists until close. */
  container(slot: SurfaceSlot): HTMLElement;
  /**
   * Replace this contribution's claims: at most one per declared slot.
   * Malformed claims are refused with a diagnostic and lose.
   */
  claim(claims: readonly PlayerSurfaceClaim[]): void;
  /** Release every claim. The containers stay mounted. */
  release(): void;
  /**
   * Leave arbitration and remove the containers after a short exit, so a
   * strip that loses its slot can still slide away. The host also closes
   * handles at disposal.
   */
  close(): void;
}

/** `player.surface@1`. */
export interface PlayerSurfaceService {
  /**
   * Open a visual contribution declared in the manifest's
   * `player.runtime.surfaces`. `render` receives every grant decision.
   * `describe`, when given, is the text a diagnostics or conformance probe
   * reports for a slot the contribution holds. Returns null for an
   * undeclared or already open contribution.
   */
  open(
    contributionId: string,
    render: (grant: PlayerSurfaceGrant) => void,
    describe?: (slot: SurfaceSlot) => string,
  ): PlayerSurfaceHandle | null;
  /** True when motion should be avoided. */
  reducedMotion(): boolean;
  /** 0 freezes motion at a deterministic frame (conformance snapshots). */
  readonly animationScale: number;
}

/** Every service this SDK version knows, by `name@version` reference. */
export interface PlayerServiceMap {
  "player.clock@1": PlayerClockService;
  "player.media@1": PlayerMediaService;
  "player.presentation.observe@1": PresentationObserveService;
  "player.surface@1": PlayerSurfaceService;
}

export type PlayerServiceId = keyof PlayerServiceMap;

// ------------------------------------------------------------ lifecycle

/**
 * Required services are always present. Optional services are null when the
 * Player does not offer them; `servicesChanged` reports a change.
 */
export type PlayerServices<
  Required extends PlayerServiceId,
  Optional extends PlayerServiceId,
> = { readonly [K in Required]: PlayerServiceMap[K] } & {
  readonly [K in Optional]: PlayerServiceMap[K] | null;
};

export interface PlayerPluginContext<
  Required extends PlayerServiceId = never,
  Optional extends PlayerServiceId = never,
> {
  readonly pluginId: string;
  readonly services: PlayerServices<Required, Optional>;
  /** False while the Player is outside its active hours. */
  awake(): boolean;
}

/**
 * Event hooks. Every hook is optional: a plugin implements only what it
 * uses. The host calls them one at a time and never from inside another.
 */
export interface PlayerPluginInstance {
  /**
   * The plugin's current state entries changed. Called right after
   * activation and then only when the plugin's own entries change, so a
   * change to another plugin never reaches this one.
   */
  stateChanged?(entries: readonly PlayerStateEntry[]): void;
  /** The Player went to sleep or woke up. */
  awakeChanged?(awake: boolean): void;
  /** An optional service appeared or disappeared. Read context.services. */
  servicesChanged?(): void;
  /** Short text a diagnostics or conformance probe reports. */
  describe?(): string;
  /** Release everything. The host already releases service bindings. */
  dispose?(): void;
}

export interface PlayerPluginDefinition<
  Required extends PlayerServiceId = never,
  Optional extends PlayerServiceId = never,
> {
  /** Must equal the manifest's id. */
  readonly id: string;
  /** Must equal the manifest's player.runtime.services. */
  readonly services: {
    readonly required: readonly Required[];
    readonly optional: readonly Optional[];
  };
  /**
   * Called when the first state entry for the plugin arrives and every
   * required service is available. The instance lives until the plugin has
   * no state, a required service goes away, or it fails.
   */
  activate(
    context: PlayerPluginContext<Required, Optional>,
  ): PlayerPluginInstance | void;
}

/** Identity helper that type-checks a plugin's Player contribution. */
export function definePlayerPlugin<
  const Required extends PlayerServiceId = never,
  const Optional extends PlayerServiceId = never,
>(
  definition: PlayerPluginDefinition<Required, Optional>,
): PlayerPluginDefinition<Required, Optional> {
  return definition;
}

/** The host's view of any definition, whatever services it names. */
export type AnyPlayerPluginDefinition = PlayerPluginDefinition<
  PlayerServiceId,
  PlayerServiceId
>;
