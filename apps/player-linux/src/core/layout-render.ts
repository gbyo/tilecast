/**
 * Multi-zone Layout → render payload projection.
 *
 * Each placement becomes an absolutely-positioned zone on the canvas.
 * Widget/primitive placements resolve to render trees; asset placements to a
 * cached image/video; playlist zones carry their own item list that the
 * renderer rotates independently. A single bad placement is isolated (skipped)
 * rather than failing the whole layout; a grossly invalid document returns
 * null so the previously active presentation stays up.
 */

import { formatValue, safeColor, type RegionalFormatting } from "./format";
import { normalizeSource } from "./datasource";
import { isAvailableAt } from "./content-availability";
import { renderWidget } from "./widget-render";
import type {
  LayoutDocument,
  LayoutPlacement,
  LayoutPrimitive,
  ManifestDataSource,
  ManifestWidget,
} from "./content-types";
import type {
  Manifest,
  ManifestAsset,
  ManifestPlaylist,
  SpanViewport,
} from "./types";
import type {
  LayoutPlaylistItem,
  LayoutRenderPayload,
  LayoutZone,
  RenderNode,
} from "./render-tree";
import {
  fallbackDurationMsFor,
  resolvePlaybackItemSettings,
} from "./playback-defaults";

const FONT_WHITELIST = new Set([
  "Inter",
  "Roboto",
  "Source Sans 3",
  "Noto Sans",
]);

export interface LayoutRenderContext {
  manifest: Manifest;
  widgets: Map<string, ManifestWidget>;
  dataSources: Map<string, ManifestDataSource>;
  at: Date;
  playback?: Record<string, unknown>;
  regionalFormat?: RegionalFormatting;
}

function assetVariant(
  manifest: Manifest,
  assetId: string,
  variantId?: string | null,
  at?: Date,
): ManifestAsset | undefined {
  return manifest.assets.find(
    (a) =>
      a.assetId === assetId &&
      variantId != null &&
      a.variantId === variantId &&
      isAvailableAt(a, at ?? new Date()),
  );
}

function mediaSrc(asset: ManifestAsset): string {
  return `tcmedia://variant/${asset.assetId}/${asset.variantId}`;
}

export function renderLayout(
  document: LayoutDocument,
  ctx: LayoutRenderContext,
  viewport?: SpanViewport,
): LayoutRenderPayload | null {
  if (document.schemaVersion !== 2 || !document.canvas) {
    return null;
  }
  const { canvas } = document;
  if (!(canvas.width > 0) || !(canvas.height > 0)) {
    return null;
  }

  const zones: LayoutZone[] = [];
  let hasVisiblePlacement = false;
  const ordered = [...document.placements].sort((a, b) => a.layer - b.layer);
  for (const placement of ordered) {
    if (!placement.visible) {
      continue;
    }
    // Group primitives are containers only; their children draw themselves.
    if (
      placement.type === "primitive" &&
      placement.primitive?.kind === "group"
    ) {
      continue;
    }
    hasVisiblePlacement = true;
    const zone = renderPlacement(placement, ctx);
    if (zone) {
      const projected = viewport ? clipZone(zone, viewport) : zone;
      if (projected) {
        zones.push(projected);
      }
    }
  }

  let backgroundImage: string | undefined;
  if (canvas.backgroundAssetId) {
    const asset = assetVariant(
      ctx.manifest,
      canvas.backgroundAssetId,
      canvas.backgroundVariantId,
      ctx.at,
    );
    if (asset) {
      backgroundImage = mediaSrc(asset);
    }
  }

  // A layout placement whose asset/window/fallback is no longer renderable
  // must not turn into a successful but blank presentation. The caller can
  // then apply the screen's branded no-content/fallback policy. An explicitly
  // empty layout remains valid, and a valid background remains a renderable
  // canvas even when it has no zones.
  if (hasVisiblePlacement && zones.length === 0 && !backgroundImage) {
    return null;
  }

  return {
    canvasWidth: viewport?.width ?? canvas.width,
    canvasHeight: viewport?.height ?? canvas.height,
    background: safeColor(canvas.backgroundColor, "#000000"),
    backgroundImage,
    backgroundImageViewport: viewport
      ? {
          x: viewport.x,
          y: viewport.y,
          width: viewport.width,
          height: viewport.height,
          canvasWidth: viewport.canvasWidth,
          canvasHeight: viewport.canvasHeight,
        }
      : undefined,
    zones,
  };
}

function clipZone(zone: LayoutZone, viewport: SpanViewport): LayoutZone | null {
  const left = Math.max(zone.x, viewport.x);
  const top = Math.max(zone.y, viewport.y);
  const right = Math.min(zone.x + zone.width, viewport.x + viewport.width);
  const bottom = Math.min(zone.y + zone.height, viewport.y + viewport.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    ...zone,
    x: left - viewport.x,
    y: top - viewport.y,
    width: right - left,
    height: bottom - top,
  };
}

function renderPlacement(
  placement: LayoutPlacement,
  ctx: LayoutRenderContext,
): LayoutZone | null {
  const base: Omit<LayoutZone, "render" | "image" | "playlistItems"> = {
    id: placement.id,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    layer: placement.layer,
    opacity: clamp01(placement.opacity),
  };

  switch (placement.type) {
    case "widget": {
      const widget = placement.widgetId
        ? ctx.widgets.get(placement.widgetId)
        : undefined;
      if (!widget) {
        return null;
      }
      const payload = renderWidget(widget, {
        dataSources: ctx.dataSources,
        assets: ctx.manifest.assets,
        at: ctx.at,
        zoneHeight: placement.height,
        regionalFormat: ctx.regionalFormat,
      });
      if (!payload) {
        return null;
      }
      return { ...base, render: payload.root };
    }
    case "asset": {
      const asset = placement.assetId
        ? assetVariant(
            ctx.manifest,
            placement.assetId,
            placement.variantId,
            ctx.at,
          )
        : undefined;
      if (!asset) {
        return null;
      }
      const fit = placement.playback?.fit ?? "contain";
      if (asset.mimeType.startsWith("video/")) {
        return {
          ...base,
          playlistItems: [
            {
              id: placement.id,
              kind: "video",
              src: mediaSrc(asset),
              durationMs: null,
              fit,
              muted: placement.playback?.muted ?? true,
              volume: 1,
              loop: placement.playback?.loop ?? true,
            },
          ],
        };
      }
      return { ...base, image: { src: mediaSrc(asset), fit } };
    }
    case "playlistZone": {
      const playlist = findPlaylist(ctx.manifest, placement.playlistId ?? null);
      if (!playlist) {
        return null;
      }
      const items = buildZoneItems(
        playlist,
        ctx.manifest,
        placement,
        ctx.at,
        ctx.playback,
      );
      if (items.length === 0) {
        return null;
      }
      return { ...base, playlistItems: items };
    }
    case "primitive": {
      if (!placement.primitive) {
        return null;
      }
      const node = renderPrimitive(placement.primitive, ctx, placement);
      if (!node) {
        return null;
      }
      return {
        ...base,
        render: node,
        radius: placement.primitive.cornerRadius,
      };
    }
    default:
      return null;
  }
}

function buildZoneItems(
  playlist: ManifestPlaylist,
  manifest: Manifest,
  placement: LayoutPlacement,
  at: Date,
  playback: Record<string, unknown> | undefined,
): LayoutPlaylistItem[] {
  const items: LayoutPlaylistItem[] = [];
  for (const item of playlist.items) {
    if (!isAvailableAt(item, at)) {
      continue;
    }
    if (item.layoutId || item.assetType === "website") {
      continue; // nested layouts / websites not supported inside a zone
    }
    const asset = manifest.assets.find(
      (a) => a.assetId === item.assetId && a.variantId === item.variantId,
    );
    if (!asset) {
      continue;
    }
    if (!isAvailableAt(asset, at)) {
      continue;
    }
    const kind = asset.mimeType.startsWith("video/")
      ? "video"
      : asset.mimeType.startsWith("image/")
        ? "image"
        : null;
    if (!kind) {
      continue;
    }
    const settings = resolvePlaybackItemSettings(
      item,
      playback,
      fallbackDurationMsFor(
        kind,
        Number.isFinite(Number(playback?.defaultImageDurationSeconds)) &&
          Number(playback?.defaultImageDurationSeconds) > 0
          ? Number(playback?.defaultImageDurationSeconds) * 1_000
          : 10_000,
      ),
    );
    items.push({
      id: item.id,
      kind,
      src: `tcmedia://variant/${asset.assetId}/${asset.variantId}`,
      durationMs: settings.durationMs,
      fit: placement.playback?.fit || settings.fitMode,
      muted: placement.playback?.muted ?? !settings.audioEnabled,
      volume: settings.volume,
      loop: playlist.items.length === 1,
    });
  }
  return items;
}

function findPlaylist(
  manifest: Manifest,
  id: string | null,
): ManifestPlaylist | null {
  if (!id) {
    return null;
  }
  if (manifest.playlist?.id === id) return manifest.playlist;
  if (manifest.directFallbackPlaylist?.id === id)
    return manifest.directFallbackPlaylist;
  return (manifest.playlists ?? []).find((p) => p.id === id) ?? null;
}

function renderPrimitive(
  primitive: LayoutPrimitive,
  ctx: LayoutRenderContext,
  placement: LayoutPlacement,
): RenderNode | null {
  switch (primitive.kind) {
    case "text": {
      const value = resolvePrimitiveText(primitive, ctx);
      if (value === null) {
        return null; // hideWhenEmpty with no data
      }
      const family = FONT_WHITELIST.has(primitive.fontFamily ?? "")
        ? primitive.fontFamily
        : "Inter";
      return {
        t: "text",
        value,
        style: {
          color: safeColor(primitive.color, "#FFFFFF"),
          background: safeColor(primitive.backgroundColor, "#00000000"),
          fontSize: primitive.fontSize ?? 48,
          fontWeight: primitive.fontWeight ?? 400,
          fontFamily: family,
          align: (primitive.textAlign as "left" | "center" | "right") ?? "left",
          verticalAlign:
            (primitive.verticalAlign as "top" | "center" | "bottom") ??
            "center",
          lineHeight: primitive.lineHeight ?? 1.2,
          letterSpacing: primitive.letterSpacing ?? 0,
          maxLines: primitive.maximumLines ?? 4,
          autoFit: primitive.autoFit ?? false,
          minFontSize: primitive.minimumFontSize ?? 8,
          padding: primitive.padding ?? 0,
          radius: primitive.cornerRadius ?? 0,
          borderWidth: primitive.borderWidth ?? 0,
          borderColor: safeColor(primitive.borderColor, "#00000000"),
        },
      };
    }
    case "rectangle":
    case "circle":
      return {
        t: "shape",
        shape: primitive.kind,
        style: {
          fill: safeColor(primitive.fillColor, "#00000000"),
          stroke: safeColor(primitive.strokeColor, "#FFFFFF"),
          strokeWidth: primitive.strokeWidth ?? 0,
          radius: primitive.cornerRadius ?? 0,
        },
      };
    case "line":
      return {
        t: "shape",
        shape: "line",
        style: {
          stroke: safeColor(primitive.strokeColor, "#FFFFFF"),
          strokeWidth: primitive.strokeWidth ?? 1,
        },
      };
    default:
      return null;
  }
  void placement;
}

function resolvePrimitiveText(
  primitive: LayoutPrimitive,
  ctx: LayoutRenderContext,
): string | null {
  const binding = primitive.binding;
  if (!binding) {
    return primitive.text ?? "";
  }
  const source = ctx.dataSources.get(binding.dataSourceId);
  const normalized = source
    ? normalizeSource(source, ctx.at, ctx.regionalFormat)
    : null;
  const record = normalized?.records[0];
  const raw = record?.rawFields[binding.field] ?? "";
  const display = record?.fields[binding.field] ?? "";
  const value =
    binding.format && binding.format !== "text"
      ? formatLayoutBinding(raw, binding.format, normalized, binding.field, ctx)
      : display || raw;
  if (!value) {
    if (binding.hideWhenEmpty) {
      return null;
    }
    return binding.fallbackText ?? "";
  }
  return `${binding.prefix ?? ""}${value}${binding.suffix ?? ""}`;
}

function formatLayoutBinding(
  raw: string,
  format: string,
  source: ReturnType<typeof normalizeSource> | null,
  field: string,
  ctx: LayoutRenderContext,
): string {
  return formatValue(raw, {
    format,
    currency: source?.fieldCurrencies[field],
    regionalFormat: ctx.regionalFormat,
  });
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
