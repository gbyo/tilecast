import type { PluginsT } from "../pluginCatalog";

const minutesPerHour = 60;
const minutesPerDay = 24 * 60;

function unitLabel(
  locale: string,
  unit: "minute" | "hour" | "day",
  count: number,
) {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(count);
}

/**
 * A job interval in words: "Every 5 minutes", "Every hour", "Every 2 days".
 * The unit names come from Intl, so every locale reads naturally without a
 * plural table of our own.
 */
export function formatCadence(minutes: number, locale: string, t: PluginsT) {
  if (minutes % minutesPerDay === 0) {
    const days = minutes / minutesPerDay;
    return days === 1
      ? t("storeDetail.cadence.day")
      : t("storeDetail.cadence.every", {
          interval: unitLabel(locale, "day", days),
        });
  }
  if (minutes % minutesPerHour === 0) {
    const hours = minutes / minutesPerHour;
    return hours === 1
      ? t("storeDetail.cadence.hour")
      : t("storeDetail.cadence.every", {
          interval: unitLabel(locale, "hour", hours),
        });
  }
  return minutes === 1
    ? t("storeDetail.cadence.minute")
    : t("storeDetail.cadence.every", {
        interval: unitLabel(locale, "minute", minutes),
      });
}

const steps: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: "day", seconds: 86400 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
];

/**
 * An instant relative to now: "2 minutes ago", "in 3 minutes". Anything
 * under a minute reads as "now" so a job that just ran never claims a
 * second count that is stale by the time it is read.
 */
export function formatRelativeTime(
  iso: string,
  locale: string,
  now: number = Date.now(),
) {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const delta = Math.round((at - now) / 1000);
  for (const step of steps) {
    if (Math.abs(delta) >= step.seconds) {
      return formatter.format(Math.round(delta / step.seconds), step.unit);
    }
  }
  return formatter.format(0, "minute");
}
