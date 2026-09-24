import {
  rotateForSynchronizedPosition,
  type SynchronizedPlaybackMetadata,
  type SynchronizedPlaybackPosition,
} from "@tilecast/player-runtime/synchronized";
import {
  presentationOverrideActive,
  takeoverActive,
  findPlaylist,
  manifestTakeover,
  resolveSelection,
} from "./schedule";
import type { StoredManifest } from "./manifest";
import type { Presentation, PresentationItem } from "./player";
import type {
  Manifest,
  ManifestAsset,
  ManifestItem,
  ManifestSchedule,
} from "./types";

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

function localDateParts(timezone: string, atMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedLocalToEpochMs(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetAsUtc;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const actual = localDateParts(timezone, guess);
      if (Object.values(actual).some((value) => !Number.isFinite(value))) {
        return null;
      }
      const actualAsUtc = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
      const correction = targetAsUtc - actualAsUtc;
      guess += correction;
      if (Math.abs(correction) < 1_000) {
        break;
      }
    }
    return guess;
  } catch {
    return null;
  }
}

function parseTime(value: string | null | undefined): {
  hour: number;
  minute: number;
} | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function previousDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Derive the same active-window start Android uses as a schedule anchor. */
export function schedulePlaybackAnchorMs(
  schedule: ManifestSchedule,
  nowMs: number,
): number | null {
  if (schedule.type === "one_time") {
    const start = Date.parse(schedule.oneTimeStart ?? "");
    return Number.isFinite(start) ? start : null;
  }

  const start = parseTime(schedule.dailyStart);
  const end = parseTime(schedule.dailyEnd);
  if (!start || !end) {
    return null;
  }

  let local;
  try {
    local = localDateParts(schedule.timezone, nowMs);
  } catch {
    return null;
  }
  if (Object.values(local).some((value) => !Number.isFinite(value))) {
    return null;
  }

  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const nowMinutes = local.hour * 60 + local.minute;
  let date = { year: local.year, month: local.month, day: local.day };
  if (endMinutes <= startMinutes && nowMinutes < endMinutes) {
    date = previousDate(date.year, date.month, date.day);
  }

  return zonedLocalToEpochMs(
    schedule.timezone,
    date.year,
    date.month,
    date.day,
    start.hour,
    start.minute,
  );
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

  let anchorMs = epoch;
  if (
    selection.source === "takeover" &&
    takeoverActive(manifest, new Date(nowMs))
  ) {
    const takeoverAnchor = Date.parse(
      manifestTakeover(manifest)?.activatedAt ?? "",
    );
    if (Number.isFinite(takeoverAnchor)) {
      anchorMs = takeoverAnchor;
    }
  } else if (
    selection.source === "quick_present" &&
    presentationOverrideActive(manifest, new Date(nowMs))
  ) {
    const overrideAnchor = Date.parse(
      manifest.presentationOverride?.startedAt ?? "",
    );
    if (Number.isFinite(overrideAnchor)) {
      anchorMs = overrideAnchor;
    }
  } else if (selection.source === "schedule" && selection.scheduleId) {
    const schedule = manifest.schedules.find(
      (candidate) => candidate.id === selection.scheduleId,
    );
    const scheduleAnchor = schedule
      ? schedulePlaybackAnchorMs(schedule, nowMs)
      : null;
    if (scheduleAnchor !== null) {
      anchorMs = scheduleAnchor;
    }
  }

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
