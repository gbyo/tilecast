import { isAvailableAt, type AvailabilityWindow } from "./availability.js";

export interface MediaItem extends AvailabilityWindow {
  assetType: string;
  assetId: string;
  variantId?: string | null;
  layoutId?: string | null;
}

export interface MediaAsset extends AvailabilityWindow {
  assetId: string;
  variantId?: string | null;
  mimeType: string;
}

export type MediaEligibility =
  | { kind: "image" | "video"; reason: null }
  | {
      kind: null;
      reason:
        | "item_unavailable"
        | "unsupported_item_kind"
        | "asset_missing"
        | "asset_unavailable"
        | "unsupported_media_type";
    };

export function isPlaylistZoneMediaItem(item: {
  assetType: string;
  layoutId?: string | null;
}): boolean {
  return (
    !item.layoutId && (item.assetType === "image" || item.assetType === "video")
  );
}

/** Eligibility for an exact media reference in a Layout playlist zone. */
export function resolveMediaEligibility(
  item: MediaItem,
  asset: MediaAsset | null | undefined,
  at: Date,
): MediaEligibility {
  if (!isAvailableAt(item, at))
    return { kind: null, reason: "item_unavailable" };
  if (!isPlaylistZoneMediaItem(item))
    return { kind: null, reason: "unsupported_item_kind" };
  if (
    !asset ||
    asset.assetId !== item.assetId ||
    (item.variantId != null && item.variantId !== asset.variantId)
  )
    return { kind: null, reason: "asset_missing" };
  if (!isAvailableAt(asset, at))
    return { kind: null, reason: "asset_unavailable" };
  const kind = asset.mimeType.startsWith("video/")
    ? "video"
    : asset.mimeType.startsWith("image/")
      ? "image"
      : null;
  return kind
    ? { kind, reason: null }
    : { kind: null, reason: "unsupported_media_type" };
}
