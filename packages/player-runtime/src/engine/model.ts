/**
 * What the playback engine works with: the host's items, plus the facts the
 * engine derives from them once. Pure data; no DOM.
 */
import type {
  EvidenceKind,
  RuntimeItem,
  RuntimeLayoutPayload,
  RuntimeWidgetPayload,
} from "../host/contract";

export const FIT_MODES: Record<string, string> = {
  contain: "contain",
  fit: "contain",
  cover: "cover",
  fill: "fill",
  stretch: "fill",
};

export function objectFit(mode: string | undefined): string {
  return FIT_MODES[String(mode)] ?? "contain";
}

/** A widget item after projection: a render tree, never a reference. */
export function widgetPayload(item: RuntimeItem): RuntimeWidgetPayload | null {
  const widget = item.widget as RuntimeWidgetPayload | undefined;
  return widget && typeof widget === "object" && "root" in widget
    ? widget
    : null;
}

export function layoutPayload(item: RuntimeItem): RuntimeLayoutPayload | null {
  const layout = item.layout as RuntimeLayoutPayload | undefined;
  return layout && typeof layout === "object" && "zones" in layout
    ? layout
    : null;
}

/** Callbacks the engine uses to tell the host what happened on screen. */
export interface EngineReporter {
  evidence(kind: EvidenceKind, itemId: string | null, zoneId?: string): void;
  playbackError(itemId: string | null, message: string): void;
  websiteRecovered(): void;
}

/**
 * One mounted playlist occurrence, as the stage sees it. `mount` increases
 * for every occurrence the engine starts, so two occurrences of the same item
 * are distinguishable and a report from a replaced one can be discarded.
 */
export interface StageEntry {
  mount: number;
  generation: number;
  item: RuntimeItem;
  /** Transition to run when this entry replaces the one on screen. */
  transition: string;
  /**
   * `preparing`: staged on the hidden layer, not yet shown.
   * `shown`: swapped in (or swapping in).
   */
  phase: "preparing" | "shown";
  /** Bumped each time a single looping video restarts in place. */
  restarts: number;
}
