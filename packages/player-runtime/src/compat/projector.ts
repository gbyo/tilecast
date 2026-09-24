/**
 * COMPATIBILITY CODE. Projects widget and layout references into RenderNode
 * trees inside the runtime, for hosts that send references plus a projection
 * context instead of already-projected trees (the WPE host).
 *
 * The projection is the same code the Electron main process runs
 * (compat/projection), at the host-corrected clock. Media is addressed by the
 * manifest's asset/variant identity and translated only through the host's
 * alias table, so the runtime never resolves media itself.
 */
import type {
  ProjectionContextV1,
  RuntimeItem,
  RuntimePresentation,
} from "../host/contract";
import { renderLayout } from "./projection/layout-render";
import { renderWidget } from "./projection/widget-render";
import type {
  LayoutDocument,
  ManifestDataSource,
  ManifestWidget,
} from "./projection/content-types";
import type { Manifest } from "./projection/types";

/** The reference player's re-selection cadence. */
export const PROJECTION_INTERVAL_MS = 30_000;

const VARIANT_PREFIX = "tcmedia://variant/";

interface ManifestLayoutEntry {
  id: string;
  document: LayoutDocument;
}

export interface Projector {
  offsetMs: number;
  needsProjection(presentation: RuntimePresentation): boolean;
  /** Throws when a reference cannot be projected at all. */
  project(
    presentation: RuntimePresentation,
    wallNowMs: number,
  ): RuntimePresentation;
}

const UNAVAILABLE: RuntimePresentation = {
  state: "unavailable",
  title: "Content unavailable",
  message: "Assigned content is not currently available.",
  status: "unavailable",
};

function isWidgetReference(item: RuntimeItem): boolean {
  return (
    item.kind === "widget" &&
    !!item.widget &&
    typeof (item.widget as { widgetAssetId?: unknown }).widgetAssetId ===
      "string"
  );
}

function isLayoutReference(item: RuntimeItem): boolean {
  return (
    item.kind === "layout" &&
    !!item.layout &&
    typeof (item.layout as { layoutId?: unknown }).layoutId === "string"
  );
}

function translateMedia(value: unknown, media: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.startsWith(VARIANT_PREFIX)
      ? (media.get(value) ?? value)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => translateMedia(entry, media));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = translateMedia((value as Record<string, unknown>)[key], media);
    }
    return out;
  }
  return value;
}

export function presentationNeedsProjection(
  presentation: RuntimePresentation,
): boolean {
  return (
    presentation.state === "playing" &&
    presentation.items.some(
      (item) => isWidgetReference(item) || isLayoutReference(item),
    )
  );
}

/**
 * Build a projector for one activation, or null when the host sent no
 * projection context. A presentation that needs one then fails to project,
 * and the activation is rejected rather than shown partially.
 */
export function createProjector(
  context: ProjectionContextV1 | undefined,
): Projector | null {
  if (!context || typeof context !== "object") return null;
  const raw = (context.manifest ?? {}) as Record<string, unknown>;
  const widgets = new Map<string, ManifestWidget>();
  for (const widget of (raw["widgets"] as ManifestWidget[] | undefined) ?? []) {
    widgets.set(widget.assetId, widget);
  }
  const dataSources = new Map<string, ManifestDataSource>();
  for (const source of (raw["dataSources"] as
    ManifestDataSource[] | undefined) ?? []) {
    dataSources.set(source.id, source);
  }
  const layouts = new Map<string, ManifestLayoutEntry>();
  for (const layout of (raw["layouts"] as ManifestLayoutEntry[] | undefined) ??
    []) {
    layouts.set(layout.id, layout);
  }
  const single = raw["layout"] as ManifestLayoutEntry | undefined;
  if (single) layouts.set(single.id, single);
  const media = new Map<string, string>();
  for (const alias of context.media ?? []) {
    media.set(
      `${VARIANT_PREFIX}${alias.assetId}/${alias.variantId}`,
      alias.uri,
    );
  }
  const manifest = {
    ...raw,
    assets: (raw["assets"] as unknown[]) ?? [],
    playlists: (raw["playlists"] as unknown[]) ?? [],
  } as unknown as Manifest;
  const offsetMs = Number.isFinite(context.clockOffsetMs)
    ? context.clockOffsetMs
    : 0;

  return {
    offsetMs,
    needsProjection: presentationNeedsProjection,
    project(presentation, wallNowMs) {
      if (presentation.state !== "playing") return presentation;
      if (!presentationNeedsProjection(presentation)) return presentation;
      const at = new Date(wallNowMs + offsetMs);
      const items: RuntimeItem[] = [];
      for (const item of presentation.items) {
        if (isWidgetReference(item)) {
          const id = (item.widget as { widgetAssetId: string }).widgetAssetId;
          const widget = widgets.get(id);
          const payload = widget
            ? renderWidget(widget, {
                dataSources,
                at,
                assets: manifest.assets,
              })
            : null;
          // The reference player skips an item that cannot render and keeps
          // the rest of the playlist.
          if (payload) {
            items.push({
              ...item,
              widget: translateMedia(payload, media) as RuntimeItem["widget"],
            });
          }
        } else if (isLayoutReference(item)) {
          const id = (item.layout as { layoutId: string }).layoutId;
          const layout = layouts.get(id);
          const payload = layout
            ? renderLayout(layout.document, {
                manifest,
                widgets,
                dataSources,
                at,
                playback: undefined,
              })
            : null;
          if (payload) {
            items.push({
              ...item,
              layout: translateMedia(payload, media) as RuntimeItem["layout"],
            });
          }
        } else {
          items.push(item);
        }
      }
      return items.length > 0 ? { ...presentation, items } : UNAVAILABLE;
    },
  };
}
