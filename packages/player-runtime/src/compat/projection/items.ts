/**
 * Manifest items → Runtime references and authorized media. This is pure
 * presentation projection; the caller supplies the selected items and instant.
 * It neither selects schedules nor downloads content.
 */
import type { RuntimeItem, ProjectionContextV1 } from "../../host/contract";
import type { Manifest, ManifestItem } from "./types";
import type { ManifestWidget } from "./content-types";
import { isAvailableAt } from "./content-availability";
import { spanViewport } from "./layout-render";
import {
  defaultImageDurationMsForPlayback,
  fallbackDurationMsFor,
  resolvePlaybackItemSettings,
} from "./playback-defaults";

/** Accepted player configuration sections that shape item projection. */
export interface ItemProjectionDefaults {
  /** `website` section of the accepted configuration. */
  website?: Record<string, unknown>;
}

const numberConfig = (
  values: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number => {
  const value = Number(values?.[key]);
  return Number.isFinite(value) ? value : fallback;
};

const stringConfig = (
  values: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string => {
  const value = values?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
};

export function projectManifestItems(
  manifest: Manifest,
  items: readonly ManifestItem[],
  playback: Record<string, unknown> | undefined,
  at: Date,
  media: Readonly<ProjectionContextV1["media"]>,
  defaults: ItemProjectionDefaults = {},
): RuntimeItem[] {
  const grants = new Map(
    media.map((entry) => [`${entry.assetId}/${entry.variantId}`, entry.uri]),
  );
  const resolve = (assetId: string, variantId: string): string => {
    const uri = grants.get(`${assetId}/${variantId}`);
    if (!uri) throw new Error("Presentation media is not authorized");
    return uri;
  };
  const widgets = new Set(
    ((manifest.widgets ?? []) as ManifestWidget[]).map(
      (widget) => widget.assetId,
    ),
  );
  const projected: RuntimeItem[] = [];
  for (const item of items) {
    if (!isAvailableAt(item, at)) continue;
    const settings = resolvePlaybackItemSettings(
      item,
      playback,
      fallbackDurationMsFor(
        item.assetType,
        defaultImageDurationMsForPlayback(playback),
      ),
    );
    const base = {
      id: item.id,
      ...settings,
      videoStartOffsetMs: item.videoStartOffsetMs ?? null,
      videoEndOffsetMs: item.videoEndOffsetMs ?? null,
    };
    if (item.layoutId) {
      projected.push({
        ...base,
        kind: "layout",
        src: "",
        layout: { layoutId: item.layoutId },
        viewport: spanViewport(manifest),
      });
    } else if (widgets.has(item.assetId)) {
      projected.push({
        ...base,
        kind: "widget",
        src: "",
        widget: { widgetAssetId: item.assetId },
      });
    } else if (item.assetType === "website") {
      const website = manifest.websites.find(
        (website) => website.assetId === item.assetId,
      );
      if (!website) continue;
      const fallback = manifest.assets.find(
        (asset) =>
          asset.assetId === website.fallbackImageAssetId &&
          (!website.fallbackVariantId ||
            asset.variantId === website.fallbackVariantId) &&
          isAvailableAt(asset, at),
      );
      projected.push({
        ...base,
        kind: "website",
        src: website.url,
        website: {
          ...website,
          // The accepted configuration's Website section supplies the same
          // defaults the other production hosts apply to a Website asset.
          loadTimeoutSeconds: numberConfig(
            defaults.website,
            "timeoutSeconds",
            website.loadTimeoutSeconds > 0 ? website.loadTimeoutSeconds : 20,
          ),
          zoomPercent:
            website.zoomPercent > 0
              ? website.zoomPercent
              : numberConfig(defaults.website, "defaultZoomPercent", 100),
          cookiePolicy: stringConfig(
            defaults.website,
            "cookiePolicy",
            website.cookiePolicy,
          ),
          reloadPolicy: website.reloadPolicy || "on_each_activation",
          failureBehavior:
            website.failureBehavior ||
            String(
              defaults.website?.["defaultFailureBehavior"] ?? "placeholder",
            ),
          refreshIntervalSeconds: website.refreshIntervalSeconds ?? null,
          customUserAgent: website.customUserAgent ?? "",
          fallbackSrc: fallback
            ? resolve(fallback.assetId, fallback.variantId)
            : null,
        },
      });
    } else {
      const asset = manifest.assets.find(
        (asset) =>
          asset.assetId === item.assetId &&
          asset.variantId === item.variantId &&
          isAvailableAt(asset, at),
      );
      if (!asset) continue;
      const kind = asset.mimeType.startsWith("image/")
        ? "image"
        : asset.mimeType.startsWith("video/")
          ? "video"
          : null;
      if (kind)
        projected.push({
          ...base,
          kind,
          src: resolve(asset.assetId, asset.variantId),
          ...(kind === "image" ? { viewport: spanViewport(manifest) } : {}),
        });
    }
  }
  return projected;
}
