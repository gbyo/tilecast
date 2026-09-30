import { useEffect, useState } from "react";
import { translateKnown } from "../../i18n";

/** How long ago the player last made contact, in the reader's language. */
export function formatLastContact(value?: string) {
  if (!value)
    return translateKnown("activity:operations.relative.never", "Never");
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60)
    return translateKnown("activity:operations.relative.justNow", "just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return translateKnown(
      "activity:operations.relative.minutesAgo",
      "{{value}}m ago",
      { value: minutes },
    );
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return translateKnown(
      "activity:operations.relative.hoursAgo",
      "{{value}}h ago",
      { value: hours },
    );
  return translateKnown(
    "activity:operations.relative.daysAgo",
    "{{value}}d ago",
    { value: Math.round(hours / 24) },
  );
}

/** "in 2 hours" from now, using the largest unit that stays readable. */
export function formatUntil(at: Date, now: Date, locale: string) {
  const minutes = Math.max(
    1,
    Math.round((at.getTime() - now.getTime()) / 60_000),
  );
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

/**
 * The same span as `formatUntil`, as a compact figure such as "38m" or "18h"
 * for a narrow time column.
 */
export function formatUntilShort(at: Date, now: Date, locale: string) {
  const minutes = Math.max(
    1,
    Math.round((at.getTime() - now.getTime()) / 60_000),
  );
  const [value, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : Math.round(minutes / 60) < 48
        ? [Math.round(minutes / 60), "hour"]
        : [Math.round(minutes / 1440), "day"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  }).format(value);
}

/**
 * A schedule's own wall-clock time. The zone name is added only when it
 * differs from the reader's, so a same-zone schedule stays uncluttered and a
 * remote one cannot be misread.
 */
export function formatScheduleTime(at: Date, timeZone: string, locale: string) {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(timeZone !== viewerZone ? { timeZoneName: "short" as const } : {}),
  }).format(at);
}

/** The current time, refreshed on an interval so relative labels stay true. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
