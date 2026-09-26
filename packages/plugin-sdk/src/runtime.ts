/**
 * The Player runtime half of the Tilecast Plugin API v1.
 *
 * A plugin's `runtime/index.ts` default-exports `defineRuntimePlugin(...)`.
 * The shared Player runtime (Electron and WPE hosts alike) discovers it when
 * the runtime is built. Nothing is loaded at run time.
 *
 * The host owns geometry, arbitration, and time: which plugin holds a strip
 * or a corner, how tall the strip is, whether it pushes content away, the
 * corrected clock, timers, reduced motion, sleep, and the lifecycle. A plugin
 * owns what it draws inside the elements the host gives it. It never reads
 * host globals, never touches the content stage, and keeps time only with its
 * context's clock, so a conformance run can freeze and advance it.
 */
import type { surfaceSlots, surfaceTiers } from "./manifest.ts";

/** Where a plugin may draw. See the manifest's runtime.surfaces. */
export type SurfaceSlot = (typeof surfaceSlots)[number];

/**
 * How strongly a plugin competes for a slot, declared once in the manifest's
 * runtime.tier and in the definition. The host compares tiers first and
 * priorities only within a tier, so a scheduled countdown can never outrank
 * an emergency alert however it is configured. A claim cannot choose its
 * own tier.
 */
export type SurfaceTier = (typeof surfaceTiers)[number];

/** Strip slots: full-width bands at the top or bottom of the screen. */
export const STRIP_SLOTS = ["strip.top", "strip.bottom"] as const;

/** Claim priorities outside this range are refused. */
export const CLAIM_PRIORITY_LIMIT = 1_000_000;

/** A strip claim taller than this, in CSS pixels, is refused. */
export const MAX_STRIP_HEIGHT_PX = 540;

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

/** An open microphone. Closing it releases the device. */
export interface MicrophoneLevels {
  close(): void;
}

/**
 * The Player microphone, for a plugin that declares hardware `microphone`.
 * It yields root-mean-square levels, never audio: no sample leaves the host
 * service, and nothing is recorded or transmitted.
 */
export interface RuntimeMicrophone {
  /** Where levels come from, or null when this Player has no microphone path. */
  readonly source: MicrophoneSource | null;
  /**
   * Start measuring. `onLevel` receives RMS levels in [0, 1], or null while
   * the input is unavailable. Returns null when there is no source.
   */
  open(onLevel: (rms: number | null) => void): MicrophoneLevels | null;
  /**
   * Report the plugin's state and derived measurements to the Player. With
   * the `host-levels` source, the host opens its microphone while the
   * reported status is not "inactive".
   */
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
  /**
   * Ask the host to evaluate again soon instead of on the next tick. Calls
   * are coalesced; one made during an evaluation schedules one more pass.
   */
  invalidate(): void;
  /** False while the Player is outside its active hours. */
  awake(): boolean;
  /** Address a cached manifest media variant. */
  mediaUrl(assetId: string, variantId: string): string;
  /** Present only for a plugin that declares hardware `microphone`. */
  readonly microphone?: RuntimeMicrophone;
}

/**
 * What a plugin wants now: at most one claim per slot. The plugin chooses
 * among its own instances first; the host compares plugins.
 */
export interface SurfaceClaim {
  slot: SurfaceSlot;
  /**
   * Higher wins within the plugin's tier. A finite number within
   * ±CLAIM_PRIORITY_LIMIT.
   */
  priority: number;
  /** Strips only: the band's height in CSS pixels (0 < h ≤ MAX_STRIP_HEIGHT_PX). */
  heightPx?: number;
  /** Strips only: overlay the content (default), or push it out of the way. */
  displayMode?: "overlay" | "push";
}

/** The host's decision for one plugin after an evaluation. */
export interface SurfaceGrant {
  /** Slots this plugin holds now. A slot not listed must show nothing. */
  readonly shown: ReadonlySet<SurfaceSlot>;
  /**
   * How far top-corner surfaces sit below the top strip, in CSS pixels. The
   * host already places corner containers clear of the strips; this is for a
   * plugin that animates or measures against it.
   */
  readonly topLiftPx: number;
  /** How far bottom-corner surfaces sit above the bottom strip. */
  readonly bottomLiftPx: number;
}

export interface RuntimePluginInstance {
  /**
   * Called once for each surface the plugin declares, with the host-owned
   * container to draw in. The plugin builds its elements here and keeps them:
   * the host never removes a plugin's elements between evaluations, so media
   * is not decoded again and animations do not restart. A plugin that loses a
   * slot keeps its elements and hides them.
   */
  mount(slot: SurfaceSlot, container: HTMLElement): void;
  /**
   * The current manifest entries of the plugin's types. Called on every
   * evaluation: after a manifest change, on each host tick (about once a
   * second), after invalidate(), and on sleep and wake. Returns the claims the
   * plugin makes now. It must not call invalidate() synchronously to get a
   * second update.
   */
  update(entries: readonly RuntimeManifestEntry[]): SurfaceClaim[];
  /** Draw what the host granted. Called after every update. */
  render(grant: SurfaceGrant): void;
  /** The Player went to sleep or woke up. Stop unneeded work while asleep. */
  setAwake?(awake: boolean): void;
  /** Text a conformance probe reports for a slot the plugin holds. */
  describe?(slot: SurfaceSlot): string;
  /** Release hardware and listeners. The host cancels the plugin's timers. */
  dispose(): void;
}

export interface RuntimePluginDefinition {
  /** Must equal the manifest's id. */
  readonly id: string;
  /** Must equal the manifest's runtime.tier. */
  readonly tier: SurfaceTier;
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

/**
 * Create an element with classes and optional text. A small convenience so
 * plugin views stay free of innerHTML, which the Player never uses.
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Compact countdown vocabulary shared by the Player's temporal widgets and
 * plugins: "2d 3h", "4h 5m", "6m 7s", "8s", and "Now".
 */
export function compactDuration(remainingMilliseconds: number): string {
  if (remainingMilliseconds <= 0) return "Now";
  const totalSeconds = Math.floor(remainingMilliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
