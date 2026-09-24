// Languages Studio ships. Adding one here also requires a matching
// `src/locales/<code>/` directory and an entry in the server's
// `preference.language` allowed list.
export const SUPPORTED_LANGUAGES = ["en", "es", "ru"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = "system" | SupportedLanguage;

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";
export const LANGUAGE_PREFERENCE_KEY = "preference.language";

// Each language is named in itself so a person who cannot read the current
// interface language can still find their own.
export const NATIVE_LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Español",
  ru: "Русский",
};

const cacheKey = "tilecast.language";

export function isSupportedLanguage(
  value: unknown,
): value is SupportedLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

export function isLanguagePreference(
  value: unknown,
): value is LanguagePreference {
  return value === "system" || isSupportedLanguage(value);
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** First browser language Studio ships, matched on the primary subtag. */
export function detectBrowserLanguage(
  languages: readonly string[] = browserLanguages(),
): SupportedLanguage {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isSupportedLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}

export function resolveLanguage(
  preference: LanguagePreference,
  languages?: readonly string[],
): SupportedLanguage {
  return preference === "system"
    ? detectBrowserLanguage(languages)
    : preference;
}

/**
 * The locally cached preference lets sign-in, setup, and the first paint after
 * a reload use the right language before the server preference has loaded.
 */
export function readCachedLanguagePreference(): LanguagePreference {
  try {
    const value = window.localStorage.getItem(cacheKey);
    return isLanguagePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeCachedLanguagePreference(preference: LanguagePreference) {
  try {
    if (window.localStorage.getItem(cacheKey) !== preference) {
      window.localStorage.setItem(cacheKey, preference);
    }
  } catch {
    // The server preference still applies once it loads.
  }
}

/**
 * Locale for Intl and `toLocale*` formatting. The browser's own tag is kept
 * when it shares the interface language, so an en-GB browser keeps day-first
 * dates in English; otherwise the interface language wins so Russian text is
 * not surrounded by English month names.
 */
export function formatLocale(
  language: string,
  languages: readonly string[] = browserLanguages(),
): string {
  const match = languages.find(
    (tag) => tag.toLowerCase().split("-")[0] === language,
  );
  return match ?? language;
}
