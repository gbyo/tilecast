export interface PlaybackSettingsItem {
  assetType: string;
  durationMs?: number | null;
  fitMode: string;
  transition: string;
  audioEnabled: boolean;
  volume: number;
  usePlayerDefaults?: boolean;
}

/** The Player's image-duration default, including its unset/invalid fallback. */
export function defaultImageDurationMsForPlayback(
  playback: Record<string, unknown> | undefined,
): number {
  const seconds = Number(playback?.["defaultImageDurationSeconds"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 10_000;
}

/**
 * The duration an item falls back to when it does not carry one of its own.
 *
 * Video is deliberately `null`, matching Android: a video's length is the
 * file's, and inventing one for it is wrong twice over. Locally it caps
 * playback at the invented value, and in a display group it *is* the slot the
 * shared timeline reserves for the item — so every video in a grouped playlist
 * would loop, or freeze on its last frame, at the fallback instead of at its
 * own end.
 */
export function fallbackDurationMsFor(
  assetType: string,
  defaultImageDurationMs: number,
): number | null {
  if (assetType === "image") {
    return defaultImageDurationMs;
  }
  if (assetType === "video") {
    return null;
  }
  return assetType === "website" ? 60_000 : 30_000;
}

/**
 * Resolve the server's player-default policy for one manifest item.
 *
 * This is deliberately a small pure function shared by fullscreen playback
 * and layout playlist zones. Keeping it here prevents the two presentation
 * paths from silently drifting when a policy revision changes.
 */
export function resolvePlaybackItemSettings(
  item: PlaybackSettingsItem,
  playback: Record<string, unknown> | undefined,
  fallbackDurationMs: number | null,
): {
  durationMs: number | null;
  fitMode: "contain" | "cover" | "stretch";
  transition: "none" | "fade" | "crossfade";
  audioEnabled: boolean;
  volume: number;
} {
  const numberConfig = (key: string, fallback: number) => {
    const value = Number(playback?.[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const usePlayerDefaults = item.usePlayerDefaults === true;
  const fitMode = String(
    usePlayerDefaults
      ? playback?.["defaultFitMode"] || "contain"
      : item.fitMode || playback?.["defaultFitMode"] || "contain",
  );
  const configuredFit =
    fitMode === "cover"
      ? "cover"
      : fitMode === "stretch"
        ? "stretch"
        : "contain";
  const transition = String(
    usePlayerDefaults
      ? playback?.["defaultTransition"] || "none"
      : item.transition || playback?.["defaultTransition"] || "none",
  );
  const volume = usePlayerDefaults
    ? Math.max(0, Math.min(1, numberConfig("defaultVolume", 0.5)))
    : Number.isFinite(item.volume)
      ? Math.max(0, Math.min(1, item.volume))
      : Math.max(0, Math.min(1, numberConfig("defaultVolume", 0.5)));
  const configuredTransition =
    transition === "fade"
      ? "fade"
      : transition === "crossfade"
        ? "crossfade"
        : "none";
  return {
    durationMs:
      usePlayerDefaults && item.assetType === "image"
        ? fallbackDurationMs
        : (item.durationMs ?? fallbackDurationMs),
    fitMode: configuredFit,
    transition: configuredTransition,
    audioEnabled: usePlayerDefaults
      ? playback?.["defaultAudioEnabled"] !== false
      : typeof item.audioEnabled === "boolean"
        ? item.audioEnabled
        : playback?.["defaultAudioEnabled"] !== false,
    volume,
  };
}
