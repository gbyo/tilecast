/**
 * The Player runtime half of the Tilecast Plugin API v1.
 *
 * A plugin's `runtime/index.ts` default-exports `defineRuntimePlugin(...)`.
 * The shared Player runtime (Electron and WPE hosts alike) discovers it when
 * the runtime is built. Nothing is loaded at run time.
 *
 * The host owns geometry, arbitration, and time: which plugin holds a strip
 * or a corner, how tall the strip is, whether it pushes content up, the
 * corrected clock, reduced motion, and the lifecycle. A plugin owns what it
 * draws inside the elements the host gives it. It never reads host globals,
 * never touches the content stage, and keeps time only with its context's
 * clock, so a conformance run can freeze and advance it.
 *
 * The contract mirrors the widget contract in
 * packages/player-runtime/src/widgets/contract.ts: engine-agnostic DOM, a
 * corrected clock, deterministic frames for conformance, and no arbitrary
 * host access.
 */
import type { surfaceSlots } from "./manifest.ts";

/** Where a plugin may draw. See the manifest's runtime.surfaces. */
export type SurfaceSlot = (typeof surfaceSlots)[number];

/**
 * How strongly a claim competes for a slot. The host compares tiers first and
 * priorities only within a tier, so a scheduled countdown can never outrank
 * an emergency alert however it is configured.
 */
export type SurfaceTier = "emergency" | "live" | "scheduled" | "ambient";

export const SURFACE_TIERS: readonly SurfaceTier[] = [
  "emergency",
  "live",
  "scheduled",
  "ambient",
];

/** One entry of the Player manifest's `plugins` array. */
export interface RuntimeManifestEntry<Config = unknown> {
  id: string;
  type: string;
  version: number;
  config: Config;
}

export interface TimerHandle {
  cancel(): void;
}

/**
 * Time for plugins. Wall time is corrected to the server's clock; monotonic
 * time is for animation and elapsed intervals. Timers belong to the plugin
 * and are cancelled when it is disposed.
 */
export interface RuntimePluginClock {
  /** Corrected (server) Unix milliseconds. */
  now(): number;
  /** Uncorrected local wall-clock Unix milliseconds. */
  localNow(): number;
  /** Monotonic milliseconds. */
  monotonicNow(): number;
  /** Run once after `delayMs` of monotonic time. */
  after(delayMs: number, callback: () => void): TimerHandle;
  /** Run every `intervalMs` until cancelled. */
  every(intervalMs: number, callback: () => void): TimerHandle;
}

/** How a host measures the room for a plugin that declares `microphone`. */
export type MicrophoneSource = "renderer-microphone" | "host-levels";

/** The Player microphone, for a plugin that declares hardware `microphone`. */
export interface RuntimeMicrophone {
  /** Where levels come from, or null when this Player has no microphone path. */
  readonly source: MicrophoneSource | null;
  /**
   * Host-measured root-mean-square levels in [0, 1] (source "host-levels").
   * Never audio. Returns an unsubscribe function.
   */
  onHostLevel(listener: (rms: number | null) => void): () => void;
  /** Report the plugin's state and derived measurements to the Player. */
  report(report: {
    status: string;
    level?: number | null;
    bucket?: unknown;
  }): void;
  /** A diagnostic line for the Player's log. Not a playback error. */
  diagnostic(message: string, detail?: Record<string, unknown>): void;
}

export interface RuntimePluginContext {
  readonly clock: RuntimePluginClock;
  /** True when motion should be avoided (the platform asks, or a frozen run). */
  reducedMotion(): boolean;
  /** 0 freezes motion at a deterministic frame (conformance snapshots). */
  readonly animationScale: number;
  /** Ask the host to re-evaluate claims now instead of on the next tick. */
  invalidate(): void;
  /** False while the Player is outside its active hours. */
  awake(): boolean;
  /** Address a cached manifest media variant. */
  mediaUrl(assetId: string, variantId: string): string;
  /** Present only for a plugin that declares hardware `microphone`. */
  readonly microphone?: RuntimeMicrophone;
}

/** What a plugin wants now: one claim per slot it would like to hold. */
export interface SurfaceClaim {
  slot: SurfaceSlot;
  tier: SurfaceTier;
  /** Higher wins within a tier. */
  priority: number;
  /** For strips: the height the strip should take, in CSS pixels. */
  heightPx?: number;
  /** For strips: overlay the content, or push it out of the way. */
  displayMode?: "overlay" | "push";
}

/** The host's decision for one plugin after an update. */
export interface SurfaceGrant {
  /** Slots this plugin holds now. A slot not listed is hidden. */
  readonly shown: ReadonlySet<SurfaceSlot>;
  /**
   * How far a bottom-corner surface must lift to clear the bottom strip, in
   * CSS pixels. The host also exposes it as `--tc-corner-lift` on the
   * bottom-corner slots.
   */
  readonly bottomLiftPx: number;
}

export interface RuntimePluginInstance {
  /**
   * Called once for each surface the plugin declares, with the host-owned
   * container to draw in. The plugin builds its elements here and keeps them:
   * the host never removes a plugin's elements between updates, so media is
   * not re-decoded and animations are not restarted.
   */
  mount(slot: SurfaceSlot, container: HTMLElement): void;
  /**
   * The current manifest entries of the plugin's types, after every manifest
   * change, on every host tick (about once a second), and after invalidate().
   * Returns the claims the plugin makes now.
   */
  update(entries: readonly RuntimeManifestEntry[]): SurfaceClaim[];
  /** Draw what the host granted. Called after every update. */
  render(grant: SurfaceGrant): void;
  /** The Player went to sleep or woke up. */
  setAwake?(awake: boolean): void;
  /** Text a conformance probe reports for a slot the plugin holds. */
  describe?(slot: SurfaceSlot): string;
  /** Release timers, hardware, and listeners. */
  dispose(): void;
}

export interface RuntimePluginDefinition {
  /** Must equal the manifest's id. */
  readonly id: string;
  /** Must equal the manifest's runtime.manifestTypes. */
  readonly manifestTypes: readonly string[];
  /** Must equal the manifest's runtime.surfaces. */
  readonly surfaces: readonly SurfaceSlot[];
  create(context: RuntimePluginContext): RuntimePluginInstance;
}

/** Identity helper that type-checks a plugin's runtime contribution. */
export function defineRuntimePlugin<
  const Definition extends RuntimePluginDefinition,
>(definition: Definition): Definition {
  return definition;
}

/**
 * Set CSS properties through the CSSOM. The Player document's policy refuses
 * `style` attributes, so plugins style their elements this way (or with
 * classes from their stylesheet).
 */
export function setStyles(
  element: HTMLElement,
  properties: Record<string, string | null | undefined>,
): void {
  for (const [name, value] of Object.entries(properties)) {
    if (value === null || value === undefined)
      element.style.removeProperty(name);
    else element.style.setProperty(name, value);
  }
}
