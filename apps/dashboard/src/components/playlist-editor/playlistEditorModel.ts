import type {
  AssetStatus,
  PlaylistItem,
  PlaylistItemInput,
} from "../../api/types";

export type PlaylistTransition = PlaylistItem["transition"] | "mixed";

export type ImageDurationSummary =
  { kind: "value"; seconds: number } | { kind: "mixed" } | { kind: "player" };

export function canManagePlaylists(role?: string) {
  return role !== "viewer";
}

export function openPlaylistPreview(id: string) {
  const popup = window.open(
    `/playlists/${encodeURIComponent(id)}/preview`,
    `tilecast-playlist-preview-${id}`,
    "popup=yes,width=1280,height=800,resizable=yes,scrollbars=no",
  );
  if (popup) {
    popup.opener = null;
    popup.focus();
  }
  return popup;
}

export function playlistDuration(items: PlaylistItem[] | null | undefined) {
  const safeItems = Array.isArray(items) ? items : [];
  return safeItems.reduce<number | null>((total, item) => {
    const duration =
      item.assetType === "image" ||
      item.assetType === "widget" ||
      item.assetType === "layout"
        ? item.durationMs
        : item.videoEndOffsetMs != null
          ? item.videoEndOffsetMs - (item.videoStartOffsetMs ?? 0)
          : item.assetDurationSeconds != null
            ? Math.round(item.assetDurationSeconds * 1000) -
              (item.videoStartOffsetMs ?? 0)
            : null;
    return total == null || duration == null ? null : total + duration;
  }, 0);
}

export function playlistItemUsesFixedDuration(item: PlaylistItem) {
  return (
    item.assetType === "image" ||
    item.assetType === "layout" ||
    (item.assetType === "widget" && item.widgetProvider !== "youtube")
  );
}

export function formatDuration(ms: number | null) {
  if (ms == null) return "Contains full-length video";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function playlistDurationLabel(
  items: PlaylistItem[] | null | undefined,
) {
  const duration = playlistDuration(items);
  if (duration != null) return formatDuration(duration);
  if (
    (Array.isArray(items) ? items : []).some(
      (item) => item.assetType === "image" && item.usePlayerDefaults,
    )
  ) {
    return "Uses Player defaults";
  }
  return formatDuration(null);
}

export function formatItemDuration(item: PlaylistItem) {
  if (item.usePlayerDefaults && item.assetType === "image") {
    return "Player defaults";
  }
  if (item.assetType === "video") {
    if (item.videoEndOffsetMs != null) {
      return formatDuration(
        item.videoEndOffsetMs - (item.videoStartOffsetMs ?? 0),
      );
    }
    return item.assetDurationSeconds != null
      ? formatDuration(
          Math.round(item.assetDurationSeconds * 1000) -
            (item.videoStartOffsetMs ?? 0),
        )
      : "Full video";
  }
  if (item.durationMs != null) return formatDuration(item.durationMs);
  return "Until source ends";
}

export function playlistItemTypeLabel(item: PlaylistItem) {
  if (item.assetType === "widget") {
    return item.widgetProvider === "youtube" ? "YouTube widget" : "Widget";
  }
  return (
    {
      image: "Image",
      video: "Video",
      layout: "Layout",
    } as const satisfies Record<
      Exclude<PlaylistItem["assetType"], "widget">,
      string
    >
  )[item.assetType];
}

// playlistItemSummary is the single muted metadata line under a timeline row:
// what the item is, how it transitions in, and whether a video plays sound.
export function playlistItemSummary(item: PlaylistItem) {
  const parts = [
    playlistItemTypeLabel(item),
    item.usePlayerDefaults
      ? "Player defaults"
      : transitionLabel(item.transition),
  ];
  if (item.assetType === "video" && !item.usePlayerDefaults) {
    parts.push(item.audioEnabled ? "Audio" : "Muted");
  }
  return parts.join(" · ");
}

export function assetStatusLabel(status: AssetStatus) {
  return (
    {
      ready: "Ready",
      uploading: "Uploading",
      uploaded: "Uploaded",
      queued: "Waiting",
      inspecting: "Inspecting",
      processing: "Processing",
      failed: "Failed",
      deleting: "Deleting",
      deleted: "Unavailable",
    } satisfies Record<AssetStatus, string>
  )[status];
}

export function transitionLabel(transition: PlaylistTransition) {
  return transition === "mixed"
    ? "Mixed"
    : transition === "crossfade"
      ? "Crossfade"
      : transition === "fade"
        ? "Fade"
        : "None";
}

export function playlistTransition(
  items: PlaylistItem[] | null | undefined,
): PlaylistTransition {
  const values = (Array.isArray(items) ? items : []).map(
    (item) => item.transition,
  );
  if (values.length === 0) return "none";
  return values.every((value) => value === values[0])
    ? (values[0] ?? "none")
    : "mixed";
}

export function playlistImageDuration(
  items: PlaylistItem[] | null | undefined,
): ImageDurationSummary {
  const imageItems = (Array.isArray(items) ? items : []).filter(
    (item) => item.assetType === "image",
  );
  const fixedItems = imageItems.filter(
    (item) => !item.usePlayerDefaults && item.durationMs != null,
  );
  if (fixedItems.length === 0) return { kind: "player" };
  const durations = fixedItems.map((item) => item.durationMs! / 1000);
  return durations.every((seconds) => seconds === durations[0])
    ? { kind: "value", seconds: durations[0]! }
    : { kind: "mixed" };
}

export function playlistAuthoringDefaults(
  items: PlaylistItem[] | null | undefined,
  assetType: PlaylistItem["assetType"],
) {
  const commonTransition = playlistTransition(items);
  const imageDuration = playlistImageDuration(items);
  const transition = commonTransition === "mixed" ? "none" : commonTransition;
  const hasFixedImageDuration =
    assetType === "image" && imageDuration.kind === "value";

  return {
    transition,
    durationMs: hasFixedImageDuration
      ? Math.round(imageDuration.seconds * 1000)
      : undefined,
    usePlayerDefaults:
      (assetType === "image" || assetType === "video") &&
      commonTransition !== "mixed" &&
      transition === "none" &&
      !hasFixedImageDuration,
  };
}

export function itemInput(item: PlaylistItem): PlaylistItemInput {
  return {
    assetId: item.assetId || undefined,
    layoutId: item.layoutId,
    durationMs: item.durationMs,
    fitMode: item.fitMode,
    transition: item.transition,
    audioEnabled: item.audioEnabled,
    volume: item.volume,
    videoStartOffsetMs: item.videoStartOffsetMs,
    videoEndOffsetMs: item.videoEndOffsetMs,
    deliveryPolicy: item.deliveryPolicy,
    usePlayerDefaults: item.usePlayerDefaults ?? false,
  };
}

export function movePlaylistItem(
  items: PlaylistItem[],
  itemId: string,
  offset: -1 | 1,
) {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(itemId);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, from + offset));
  if (from === to) return ids;
  const [moved] = ids.splice(from, 1);
  if (moved) ids.splice(to, 0, moved);
  return ids;
}

export function movePlaylistItemToEdge(
  items: PlaylistItem[],
  itemId: string,
  edge: "top" | "bottom",
) {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(itemId);
  if (from < 0) return ids;
  const to = edge === "top" ? 0 : ids.length - 1;
  if (from === to) return ids;
  const [moved] = ids.splice(from, 1);
  if (moved) ids.splice(to, 0, moved);
  return ids;
}

export function reorderPlaylistItems(
  items: PlaylistItem[],
  draggedId: string,
  targetId: string,
) {
  if (draggedId === targetId) return items.map((item) => item.id);
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return ids;
  const [moved] = ids.splice(from, 1);
  if (moved) ids.splice(to, 0, moved);
  return ids;
}

export function itemHasTransitionOverride(
  item: PlaylistItem,
  commonTransition: PlaylistTransition,
) {
  return (
    item.usePlayerDefaults === true ||
    (commonTransition !== "mixed" && item.transition !== commonTransition)
  );
}
