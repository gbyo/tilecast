/**
 * The item-surface abstraction. The playback engine depends only on these
 * interfaces, never on a particular engine or host: an image, an HTML video, a
 * layout, a compatibility widget, a remote web view, or (should hardware
 * testing ever justify it) a native media pipeline behind the same contract.
 */
import type { EvidenceKind, RuntimeItem } from "../host/contract";
import type { RuntimeClock } from "../clock/scheduler";
import type { RuntimeWidgetHost } from "../widgets/host";

export interface MediaSurface {
  /** The surface's root node; the stage places it in a layer. */
  readonly element: HTMLElement;
  /**
   * Load until the surface has something to show. Resolves when it can be
   * swapped in; rejects with a reason when it cannot be shown at all.
   */
  prepare(): Promise<void>;
  /** Begin playback now that the surface is visible. */
  activate(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  /** Release every decoder, timer and listener. Idempotent. */
  dispose(): void;
}

/** Surfaces that loop in place (a single-video playlist). */
export interface RestartableSurface extends MediaSurface {
  restart(): void;
}

export function isRestartable(
  surface: MediaSurface,
): surface is RestartableSurface {
  return typeof (surface as Partial<RestartableSurface>).restart === "function";
}

/**
 * How a surface reports on its occurrence. The stage binds a sink to one
 * mount, so a report from a replaced surface can never reach its successor.
 */
export interface SurfaceSink {
  ended(source: "ended" | "end-offset"): void;
  failed(message: string): void;
  resumed(): void;
  evidence(kind: EvidenceKind, zoneId?: string): void;
  websiteFailed(reason: string, fallback: boolean): void;
  websiteRecovered(): void;
  fallbackShown(): void;
  /**
   * Content inside one Layout zone failed. The Layout keeps playing; the
   * failure is reported for the Layout item with the zone's identity.
   */
  zoneFailed(zoneId: string, message: string): void;
}

export interface SurfaceEnvironment {
  clock: RuntimeClock;
  sink: SurfaceSink;
  /** Scale for animations inside surfaces (0 in snapshot conformance runs). */
  animationScale: number;
  /**
   * Creates the remote web surface for a website or youtube item (a root
   * item, or a synthetic one for a Layout zone), or null when this host has
   * no isolated remote web mechanism.
   */
  remoteWeb?: (item: RuntimeItem, sink: SurfaceSink) => MediaSurface | null;
  /** First-class Widget mounting; absent where no Widget can run. */
  widgets?: RuntimeWidgetHost;
}

export type SurfaceFactory = (
  item: RuntimeItem,
  environment: SurfaceEnvironment,
) => MediaSurface;
