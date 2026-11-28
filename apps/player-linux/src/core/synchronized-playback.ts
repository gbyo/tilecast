import {
  rotateForSynchronizedPosition,
  type SynchronizedPlaybackMetadata,
  type SynchronizedPlaybackPosition,
} from "@tilecast/player-runtime/synchronized";
import { findPlaylist, resolveSelection } from "./schedule";
import type { StoredManifest } from "./manifest";
import type { Presentation, PresentationItem } from "./player";
import type { Manifest, ManifestAsset, ManifestItem } from "./types";

// The timeline math is shared with every host through the Player Runtime.
export {
  activateSynchronizedClock,
  monotonicNowMs,
  synchronizedNowMs,
  synchronizedPlaybackPosition,
  type SynchronizedClockActivation,
  type SynchronizedPlaybackMetadata,
  type SynchronizedPlaybackPosition,
} from "@tilecast/player-runtime/synchronized";

export type PlayingPresentation = Extract<Presentation, { state: "playing" }>;
export type SynchronizedPlayingPresentation = PlayingPresentation & {
  synchronizedPlayback: SynchronizedPlaybackMetadata;
};

/**
 * A presentation handed to the renderer, told explicitly whether a shared
 * timeline owns its occurrence changes. The renderer must not have to infer
 * that from the presence of metadata it otherwise ignores.
 */
export type ProjectedSynchronizedPresentation =
  SynchronizedPlayingPresentation & {
    synchronized: true;
  };

function positiveDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : null;
}

/** Match Android's effective playlist durations for deterministic group timing. */
export function effectiveDurationMs(
  rendered: PresentationItem,
  manifestItem: ManifestItem | undefined,
  asset: ManifestAsset | undefined,
): number {
  // Only the manifest carries an authored duration. A video's rendered
  // duration may be a renderer-side fallback rather than the file's length,
  // and taking it as authored would hand every video the same slot on the
  // shared timeline no matter how long it actually runs.
  const explicit = positiveDuration(
    rendered.kind === "video"
      ? manifestItem?.durationMs
      : (manifestItem?.durationMs ?? rendered.durationMs),
  );
  if (explicit !== null) {
    return explicit;
  }

  if (
    rendered.kind === "website" ||
    rendered.kind === "widget" ||
    rendered.kind === "layout" ||
    rendered.kind === "youtube"
  ) {
    return 30_000;
  }

  if (rendered.kind === "video") {
    const start =
      manifestItem?.videoStartOffsetMs ?? rendered.videoStartOffsetMs ?? 0;
    const end =
      manifestItem?.videoEndOffsetMs ??
      rendered.videoEndOffsetMs ??
      (asset?.durationSeconds != null
        ? Math.round(asset.durationSeconds * 1_000)
        : null);
    if (end !== null) {
      return Math.max(1, end - start);
    }
  }

  return 10_000;
}

/**
 * Rotate a normal presentation so the renderer mounts the expected shared item
 * first and only waits for the remaining portion of that occurrence.
 */
export function projectSynchronizedPresentation(
  presentation: SynchronizedPlayingPresentation,
  position: SynchronizedPlaybackPosition,
  generation: number,
): ProjectedSynchronizedPresentation {
  return {
    ...presentation,
    items: rotateForSynchronizedPosition(presentation.items, position),
    generation,
    // The renderer suppresses its own advancement on this flag alone.
    synchronized: true,
  };
}

function playlistItemMaps(manifest: Manifest) {
  const items = new Map<string, ManifestItem>();
  for (const playlist of [
    manifest.playlist,
    manifest.directFallbackPlaylist,
    ...(manifest.playlists ?? []),
  ]) {
    for (const item of playlist?.items ?? []) {
      items.set(item.id, item);
    }
  }
  return items;
}

/** Add shared-timeline metadata to a Linux playing presentation when grouped. */
export function enrichSynchronizedPresentation(
  presentation: Presentation,
  stored: StoredManifest | null,
  nowMs = Date.now(),
): Presentation | SynchronizedPlayingPresentation {
  if (presentation.state !== "playing" || !stored?.manifest.syncGroup) {
    return presentation;
  }

  const manifest = stored.manifest;
  // The top-of-function guard already proved a sync group exists, but that
  // narrowing does not survive rebinding stored.manifest to `manifest`.
  // Capture it in a locally-narrowed const so the accesses below type-check.
  const syncGroup = manifest.syncGroup;
  if (!syncGroup) {
    return presentation;
  }
  const selection = resolveSelection(manifest, new Date(nowMs));
  const playlist = findPlaylist(manifest, selection.playlistId);
  if (
    !playlist ||
    playlist.items.length === 0 ||
    presentation.items.length === 0
  ) {
    return presentation;
  }

  const epoch = Date.parse(syncGroup.playbackEpoch ?? "");
  if (!Number.isFinite(epoch)) {
    return presentation;
  }

  const selectedAnchor = Date.parse(selection.playbackAnchor ?? "");
  const anchorMs = Number.isFinite(selectedAnchor) ? selectedAnchor : epoch;

  const manifestItems = playlistItemMaps(manifest);
  const assets = new Map(
    manifest.assets.map((asset) => [asset.variantId, asset]),
  );
  const durationsMs = presentation.items.map((rendered) => {
    const source = manifestItems.get(rendered.id);
    return effectiveDurationMs(
      rendered,
      source,
      source?.variantId ? assets.get(source.variantId) : undefined,
    );
  });

  return {
    ...presentation,
    synchronizedPlayback: {
      groupId: syncGroup.id,
      anchorMs,
      durationsMs,
    },
  };
}
