import type { SettingDefinition } from "../api/types";

const legacyTimezoneAliases: Record<string, string> = {
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
};

const timezoneFallback = [
  "UTC",
  "Africa/Abidjan",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  "America/Anchorage",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Sao_Paulo",
  "America/St_Johns",
  "America/Toronto",
  "Asia/Bangkok",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Jakarta",
  "Asia/Jerusalem",
  "Asia/Kathmandu",
  "Asia/Kolkata",
  "Asia/Manila",
  "Asia/Riyadh",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Atlantic/Reykjavik",
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Darwin",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Rome",
  "Pacific/Auckland",
  "Pacific/Honolulu",
  "Pacific/Apia",
  "Pacific/Fiji",
];

const commonLocaleTags = [
  "ar-SA",
  "de-DE",
  "en-GB",
  "en-US",
  "es-ES",
  "fa-IR",
  "fr-FR",
  "he-IL",
  "hi-IN",
  "ja-JP",
  "ko-KR",
  "pt-BR",
  "ru-RU",
  "zh-CN",
  "zh-TW",
];
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const cldrFirstDay: Record<string, (typeof weekdays)[number]> = {
  AF: "saturday",
  AG: "sunday",
  AS: "sunday",
  BD: "sunday",
  BH: "saturday",
  BR: "sunday",
  BS: "sunday",
  BT: "sunday",
  BW: "sunday",
  BZ: "sunday",
  CA: "sunday",
  CO: "sunday",
  DJ: "saturday",
  DM: "sunday",
  DO: "sunday",
  DZ: "saturday",
  EG: "saturday",
  ET: "sunday",
  GT: "sunday",
  GU: "sunday",
  HK: "sunday",
  HN: "sunday",
  ID: "sunday",
  IL: "sunday",
  IN: "sunday",
  IQ: "saturday",
  IR: "saturday",
  IS: "sunday",
  JM: "sunday",
  JO: "saturday",
  JP: "sunday",
  KE: "sunday",
  KH: "sunday",
  KR: "sunday",
  KW: "saturday",
  LA: "sunday",
  LY: "saturday",
  MH: "sunday",
  MM: "sunday",
  MO: "sunday",
  MT: "sunday",
  MV: "friday",
  MX: "sunday",
  MZ: "sunday",
  NI: "sunday",
  NP: "sunday",
  OM: "saturday",
  PA: "sunday",
  PE: "sunday",
  PH: "sunday",
  PK: "sunday",
  PT: "sunday",
  PY: "sunday",
  QA: "saturday",
  SD: "saturday",
  SG: "sunday",
  SV: "sunday",
  SY: "saturday",
  TH: "sunday",
  TT: "sunday",
  TW: "sunday",
  UM: "sunday",
  US: "sunday",
  VE: "sunday",
  VI: "sunday",
  WS: "sunday",
  YE: "sunday",
  ZA: "sunday",
  ZW: "sunday",
};
const likelyRegionFallback: Record<string, string> = {
  ar: "EG",
  de: "DE",
  dv: "MV",
  en: "US",
  es: "ES",
  fa: "IR",
  fr: "FR",
  he: "IL",
  hi: "IN",
  ja: "JP",
  ko: "KR",
  pt: "BR",
  ru: "RU",
  zh: "CN",
};
const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/;

export function normalizeLocalTime(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return localTimePattern.test(trimmed) ? trimmed.slice(0, 5) : trimmed;
}

export function normalizeTimezone(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return legacyTimezoneAliases[trimmed] ?? trimmed;
}

export function canonicalizeLocale(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

export function isValidTimezone(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Treat Intl as the runtime validator when it knows the identifier. On older
 * runtimes, allow an IANA-shaped manual identifier to reach the server's
 * authoritative tzdb validation instead of restricting users to our fallback
 * suggestions. Bare abbreviations are not offered as manual choices.
 */
export function isTimezoneIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = normalizeTimezone(value);
  if (normalized === "UTC" || isValidTimezone(normalized)) return true;
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof intl.supportedValuesOf === "function") return false;
  const parts = normalized.split("/");
  return (
    parts.length > 1 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !/[\s\\]/.test(part),
    )
  );
}

/** Resolve a locale's CLDR week start, including Unicode locale extensions. */
type LocaleWithWeekInfo = Intl.Locale & {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
};

export function firstDayOfWeekForLocale(value: unknown) {
  const canonical = canonicalizeLocale(value);
  if (!canonical) return "monday";
  const intl = Intl as unknown as {
    Locale?: new (tag: string) => LocaleWithWeekInfo;
  };
  const locale = intl.Locale ? new intl.Locale(canonical) : undefined;
  const info =
    typeof locale?.getWeekInfo === "function"
      ? locale.getWeekInfo()
      : locale?.weekInfo;
  const firstDay = info?.firstDay;
  if (firstDay && firstDay >= 1 && firstDay <= 7) return weekdays[firstDay % 7];
  return firstDayOfWeekFallback(canonical, locale);
}

function firstDayOfWeekFallback(
  canonical: string,
  locale?: LocaleWithWeekInfo,
) {
  const parts = canonical.split("-");
  const unicodeIndex = parts.indexOf("u");
  const unicodeParts = unicodeIndex < 0 ? [] : parts.slice(unicodeIndex + 1);
  const unicodeValue = (key: string) => {
    const index = unicodeParts.indexOf(key);
    return index < 0 ? undefined : unicodeParts[index + 1];
  };
  const fw = unicodeValue("fw");
  const extensionWeekday = weekdays.find((day) => day.slice(0, 3) === fw);
  if (extensionWeekday) return extensionWeekday;
  const regionOverride = unicodeValue("rg")?.slice(0, 2).toUpperCase();
  if (regionOverride) return cldrFirstDay[regionOverride] ?? "monday";
  if (unicodeValue("ca") === "iso8601") return "monday";

  const coreEnd = parts.findIndex(
    (part, index) => index > 0 && part.length === 1,
  );
  const core = parts.slice(0, coreEnd < 0 ? parts.length : coreEnd);
  const explicitRegion = core.find(
    (part) =>
      (part.length === 2 && part === part.toUpperCase()) ||
      /^\d{3}$/.test(part),
  );
  if (explicitRegion) return cldrFirstDay[explicitRegion] ?? "monday";

  const subdivisionRegion = unicodeValue("sd")?.slice(0, 2).toUpperCase();
  if (subdivisionRegion) return cldrFirstDay[subdivisionRegion] ?? "monday";

  const region =
    locale?.maximize().region ?? likelyRegionFallback[parts[0]!] ?? "";
  return cldrFirstDay[region] ?? "monday";
}

export function normalizeSettingValues(
  values: Record<string, unknown>,
  definitions: SettingDefinition[],
) {
  const normalized = { ...values };
  for (const definition of definitions) {
    if (!Object.hasOwn(normalized, definition.key)) continue;
    if (definition.type === "local_time")
      normalized[definition.key] = normalizeLocalTime(
        normalized[definition.key],
      );
    if (definition.type === "timezone")
      normalized[definition.key] = normalizeTimezone(
        normalized[definition.key],
      );
    if (definition.type === "locale") {
      normalized[definition.key] =
        canonicalizeLocale(normalized[definition.key]) ??
        normalized[definition.key];
    }
  }
  return normalized;
}

function supportedTimezones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  try {
    const supported = intl.supportedValuesOf?.("timeZone");
    if (supported?.length)
      return ["UTC", ...supported.filter((zone) => zone !== "UTC")];
  } catch {
    // Older Intl implementations use the broad fallback below.
  }
  return [...timezoneFallback];
}

/** Return supported IANA zones and retain any valid existing/manual value. */
export function timezoneOptions(current?: unknown, candidate?: unknown) {
  const zones = supportedTimezones();
  for (const value of [
    normalizeTimezone(current),
    normalizeTimezone(candidate),
  ]) {
    if (isTimezoneIdentifier(value) && !zones.includes(value))
      zones.push(value);
  }
  return zones;
}

/** Humanize the city/area safely while keeping the canonical IANA identifier visible. */
export function timezoneLabel(zone: string) {
  if (zone === "UTC") return zone;
  const name = zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;
  return `${name} (${zone})`;
}

export function localeSuggestions() {
  return commonLocaleTags;
}
