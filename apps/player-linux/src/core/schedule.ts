/** Offline, timezone-aware schedule and takeover resolution. */

import type { Manifest, ManifestSchedule } from "./types";

export const manifestTakeover = (manifest: Manifest) =>
  manifest.takeover ?? manifest.emergency ?? null;

export interface Selection {
  playlistId: string | null;
  layoutId: string | null;
  scheduleId: string | null;
  takeoverId: string | null;
  source: string;
  /** Exact next schedule/takeover boundary, for prompt unattended changes. */
  nextTransitionAt: string | null;
  /** Start of the winning window, used as a synchronized-playback anchor. */
  playbackAnchor: string | null;
}

export interface DisplayPolicySelection {
  action: ManifestSchedule["displayAction"];
  scheduleId: string | null;
  nextTransitionAt: string | null;
  policyState: "normal" | "powered_off_by_policy" | "unknown";
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type Clock = [hour: number, minute: number, second: number];

interface Window {
  schedule: ManifestSchedule;
  start: number;
  end: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const weeklyWindowCache = new Map<
  string,
  Array<{ start: number; end: number }>
>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function zonedParts(timezone: string, at: Date): ZonedParts | null {
  try {
    const parts = formatter(timezone).formatToParts(at);
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? NaN);
    const value = {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
    return Object.values(value).every(Number.isFinite) ? value : null;
  } catch {
    return null;
  }
}

function dateString(parts: ZonedParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateParts(value: string): ZonedParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function addDays(value: string, days: number): string {
  const parts = dateParts(value);
  if (!parts) return value;
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return date.toISOString().slice(0, 10);
}

function weekday(value: string): number {
  const parts = dateParts(value)!;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function parseClock(value: string | null | undefined): Clock | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  return hour <= 23 && minute <= 59 && second <= 59
    ? [hour, minute, second]
    : null;
}

function wallEpoch({ year, month, day, hour, minute, second }: ZonedParts) {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Resolve a wall-clock time in an IANA zone. Repeated times use the earlier
 * instant for starts and the later instant for ends. Gap times use the first
 * valid instant after the gap.
 */
function resolveLocal(
  date: string,
  [hour, minute, second]: Clock,
  timezone: string,
  end: boolean,
): number | null {
  const day = dateParts(date);
  if (!day) return null;
  const naive = wallEpoch({ ...day, hour, minute, second });
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 60 * 60 * 1000;
    const local = zonedParts(timezone, new Date(sample));
    if (local) offsets.add(wallEpoch(local) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .sort((a, b) => a - b);
  const matches = [];
  let before: number | undefined;
  let after: number | undefined;
  for (const candidate of candidates) {
    const local = zonedParts(timezone, new Date(candidate));
    if (!local) continue;
    const wall = wallEpoch(local);
    if (wall === naive) matches.push(candidate);
    if (wall < naive) before = candidate;
    if (wall > naive && before !== undefined) {
      after = candidate;
      break;
    }
  }
  if (matches.length > 0) return end ? matches.at(-1)! : matches[0]!;
  if (before === undefined || after === undefined) return null;

  // The two guesses straddle a forward offset transition. Bisect at whole
  // seconds to find its boundary without carrying seconds into the gap end.
  while (after - before > 1000) {
    const middle: number = before + Math.floor((after - before) / 2000) * 1000;
    const local = zonedParts(timezone, new Date(middle));
    if (!local) return null;
    if (wallEpoch(local) < naive) before = middle;
    else after = middle;
  }
  return after;
}

function windows(schedule: ManifestSchedule, at: Date): Window[] {
  if (schedule.type === "one_time") {
    const start = Date.parse(schedule.oneTimeStart ?? "");
    const end = Date.parse(schedule.oneTimeEnd ?? "");
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ schedule, start, end }]
      : [];
  }
  if (schedule.type !== "weekly") return [];
  const local = zonedParts(schedule.timezone, at);
  const startClock = parseClock(schedule.dailyStart);
  const endClock = parseClock(schedule.dailyEnd);
  if (!local || !startClock || !endClock) return [];

  const today = dateString(local);
  const days = new Set(schedule.daysOfWeek ?? []);
  const cacheKey = [
    schedule.timezone,
    today,
    schedule.dailyStart,
    schedule.dailyEnd,
    [...days].sort((a, b) => a - b).join(","),
    schedule.startDate ?? "",
    schedule.endDate ?? "",
  ].join("|");
  const cached = weeklyWindowCache.get(cacheKey);
  if (cached) return cached.map((window) => ({ schedule, ...window }));
  const seconds = ([hour, minute, second]: Clock) =>
    hour * 3600 + minute * 60 + second;
  const overnight = seconds(endClock) <= seconds(startClock);
  const result: Window[] = [];
  for (let offset = -1; offset <= 8; offset += 1) {
    const origin = addDays(today, offset);
    // Bounds belong to the window's start day. This is important for the
    // after-midnight portion of a schedule whose endDate was yesterday.
    if (
      !days.has(weekday(origin)) ||
      (schedule.startDate && origin < schedule.startDate) ||
      (schedule.endDate && origin > schedule.endDate)
    ) {
      continue;
    }
    const start = resolveLocal(origin, startClock, schedule.timezone, false);
    const end = resolveLocal(
      overnight ? addDays(origin, 1) : origin,
      endClock,
      schedule.timezone,
      true,
    );
    if (start !== null && end !== null && end > start) {
      result.push({ schedule, start, end });
    }
  }
  if (weeklyWindowCache.size >= 20_000) weeklyWindowCache.clear();
  weeklyWindowCache.set(
    cacheKey,
    result.map(({ start, end }) => ({ start, end })),
  );
  return result;
}

export function scheduleApplies(schedule: ManifestSchedule, at: Date): boolean {
  const now = at.getTime();
  return windows(schedule, at).some(
    (window) => now >= window.start && now < window.end,
  );
}

export function takeoverActive(manifest: Manifest, at: Date): boolean {
  const takeover = manifestTakeover(manifest);
  if (!takeover) return false;
  const start = Date.parse(takeover.activatedAt);
  const end = Date.parse(takeover.expiresAt);
  const now = at.getTime();
  return (
    Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end
  );
}

export function presentationOverrideActive(
  manifest: Manifest,
  at: Date,
): boolean {
  const override = manifest.presentationOverride;
  if (!override) return false;
  const start = Date.parse(override.startedAt);
  const end = override.expiresAt ? Date.parse(override.expiresAt) : Infinity;
  const now = at.getTime();
  return Number.isFinite(start) && now >= start && now < end;
}

export function resolveSelection(manifest: Manifest, at: Date): Selection {
  const now = at.getTime();
  const takeover = manifestTakeover(manifest);
  const override = manifest.presentationOverride ?? null;
  const allWindows = (manifest.schedules ?? []).flatMap((schedule) =>
    schedule.playlistId || schedule.layoutId ? windows(schedule, at) : [],
  );
  const futureTransitions = allWindows
    .flatMap((window) => [window.start, window.end])
    .filter((transition) => transition > now);
  if (takeover) {
    const starts = Date.parse(takeover.activatedAt);
    if (Number.isFinite(starts) && starts > now) futureTransitions.push(starts);
  }
  if (override) {
    const starts = Date.parse(override.startedAt);
    if (Number.isFinite(starts) && starts > now) futureTransitions.push(starts);
    if (override.expiresAt) {
      const expires = Date.parse(override.expiresAt);
      if (Number.isFinite(expires) && expires > now)
        futureTransitions.push(expires);
    }
  }
  const transition = nextTransition(futureTransitions);

  if (takeover && takeoverActive(manifest, at)) {
    const expires = Date.parse(takeover.expiresAt);
    if (Number.isFinite(expires) && expires > now)
      futureTransitions.push(expires);
    return {
      playlistId: takeover.playlistId,
      layoutId: null,
      scheduleId: null,
      takeoverId: takeover.id,
      source: "takeover",
      nextTransitionAt: nextTransition(futureTransitions),
      playbackAnchor: takeover.activatedAt,
    };
  }

  if (override && presentationOverrideActive(manifest, at)) {
    const playlistId =
      override.playlistId ??
      (override.contentType === "playlist" ? override.contentId : null);
    const layoutId =
      override.layoutId ??
      (override.contentType === "layout" ? override.contentId : null);
    return {
      playlistId,
      layoutId,
      scheduleId: null,
      takeoverId: null,
      source: "quick_present",
      nextTransitionAt: transition,
      playbackAnchor: override.startedAt,
    };
  }

  const winner = allWindows
    .filter((window) => now >= window.start && now < window.end)
    .sort(
      (a, b) =>
        b.schedule.priority - a.schedule.priority ||
        b.schedule.specificity - a.schedule.specificity ||
        b.start - a.start ||
        a.schedule.id.localeCompare(b.schedule.id),
    )[0];
  if (winner) {
    return {
      playlistId: winner.schedule.playlistId ?? null,
      layoutId: winner.schedule.layoutId ?? null,
      scheduleId: winner.schedule.id,
      takeoverId: null,
      source: "schedule",
      nextTransitionAt: transition,
      playbackAnchor: new Date(winner.start).toISOString(),
    };
  }

  const directPlaylist = manifest.playlist ?? manifest.directFallbackPlaylist;
  if (directPlaylist) {
    return {
      playlistId: directPlaylist.id,
      layoutId: null,
      scheduleId: null,
      takeoverId: null,
      source: "direct",
      nextTransitionAt: transition,
      playbackAnchor: null,
    };
  }
  const directLayout = (manifest.layout ?? manifest.directFallbackLayout) as
    { id: string } | null | undefined;
  if (directLayout) {
    return {
      playlistId: null,
      layoutId: directLayout.id,
      scheduleId: null,
      takeoverId: null,
      source: "direct",
      nextTransitionAt: transition,
      playbackAnchor: null,
    };
  }
  return {
    playlistId: null,
    layoutId: null,
    scheduleId: null,
    takeoverId: null,
    source: "none",
    nextTransitionAt: transition,
    playbackAnchor: null,
  };
}

/** Resolve Display Control actions with the same windows and precedence as
 * content schedules. Display policies are optional manifest entries, so older
 * players simply see no action field and retain their existing behavior. */
export function resolveDisplayPolicy(
  manifest: Manifest,
  at: Date,
): DisplayPolicySelection {
  const now = at.getTime();
  const policyWindows = (manifest.schedules ?? []).flatMap((schedule) =>
    schedule.displayAction ? windows(schedule, at) : [],
  );
  const futureTransitions = policyWindows
    .flatMap((window) => [window.start, window.end])
    .filter((transition) => transition > now);
  const winner = policyWindows
    .filter((window) => now >= window.start && now < window.end)
    .sort(
      (a, b) =>
        b.schedule.priority - a.schedule.priority ||
        b.schedule.specificity - a.schedule.specificity ||
        b.start - a.start ||
        a.schedule.id.localeCompare(b.schedule.id),
    )[0];
  const action = winner?.schedule.displayAction ?? null;
  return {
    action,
    scheduleId: winner?.schedule.id ?? null,
    nextTransitionAt: nextTransition(futureTransitions),
    policyState:
      action?.type === "display_power_off"
        ? "powered_off_by_policy"
        : action
          ? "normal"
          : "normal",
  };
}

function nextTransition(values: number[]): string | null {
  const value = values.length > 0 ? Math.min(...values) : NaN;
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function findPlaylist(manifest: Manifest, playlistId: string | null) {
  if (!playlistId) return null;
  if (manifest.playlist?.id === playlistId) return manifest.playlist;
  if (manifest.directFallbackPlaylist?.id === playlistId)
    return manifest.directFallbackPlaylist;
  return (
    (manifest.playlists ?? []).find((playlist) => playlist.id === playlistId) ??
    null
  );
}
