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

/** Renderable zone categories. Individual Widget capabilities are negotiated. */
export function isPlaylistZoneItem(item: {
  assetType: string;
  layoutId?: string | null;
}): boolean {
  return (
    !item.layoutId &&
    (item.assetType === "image" ||
      item.assetType === "video" ||
      item.assetType === "widget")
  );
}

/** What kind of item a Layout playlist zone cannot play. */
export type PlaylistZoneItemKind =
  "widget" | "website" | "youtube" | "layout" | "other";

export interface PlaylistZoneItemLike {
  id: string;
  /** The operator-facing name of the item's asset or Layout. */
  assetName: string;
  assetType: string;
  widgetProvider?: string | null;
  layoutId?: string | null;
}

export interface PlaylistZoneUnsupportedItem {
  id: string;
  name: string;
  kind: PlaylistZoneItemKind;
}

/**
 * Names why a Playlist item cannot play in a Layout playlist zone, or null
 * when it can. This is the one place the zone item rule is described to an
 * operator: it classifies exactly the items {@link isPlaylistZoneItem}
 * rejects, and the server's publication and assignment checks reject the same
 * set, so Studio can only warn about what would fail.
 */
export function classifyPlaylistZoneItem(
  item: Pick<PlaylistZoneItemLike, "assetType" | "widgetProvider" | "layoutId">,
): PlaylistZoneItemKind | null {
  if (isPlaylistZoneItem(item)) return null;
  if (item.layoutId || item.assetType === "layout") return "layout";
  return "other";
}

/** The items of a Playlist that a Layout playlist zone cannot play, in playlist order. */
export function playlistZoneUnsupportedItems(
  items: readonly PlaylistZoneItemLike[],
): PlaylistZoneUnsupportedItem[] {
  const unsupported: PlaylistZoneUnsupportedItem[] = [];
  for (const item of items) {
    const kind = classifyPlaylistZoneItem(item);
    if (kind) unsupported.push({ id: item.id, name: item.assetName, kind });
  }
  return unsupported;
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
