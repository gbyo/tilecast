import i18next, { type BackendModule } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  formatLocale,
  readCachedLanguagePreference,
  resolveLanguage,
  writeCachedLanguagePreference,
  type LanguagePreference,
  type SupportedLanguage,
} from "./languages";
import { DEFAULT_NAMESPACE, NAMESPACES, englishResources } from "./resources";

export * from "./languages";
export { NAMESPACES, type Namespace } from "./resources";

// Non-English locales are split into their own chunks and fetched only when
// that language is chosen, so English installations download no translations.
const localeLoaders = import.meta.glob<{ default: Record<string, unknown> }>([
  "../locales/*/*.json",
  "!../locales/en/*.json",
]);

const lazyLocales: BackendModule = {
  type: "backend",
  init: () => undefined,
  read(language, namespace, callback) {
    const load = localeLoaders[`../locales/${language}/${namespace}.json`];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (module) => callback(null, module.default),
      (error: unknown) => callback(error as Error, null),
    );
  },
};

export const i18n = i18next.createInstance();

let requestedLanguage: SupportedLanguage | null = null;
let languagePreviewDirty = false;

i18n.on("languageChanged", () => {
  if (typeof document !== "undefined") {
    document.documentElement.lang =
      i18n.resolvedLanguage ?? DEFAULT_LANGUAGE;
  }
});

/**
 * Resolves once the starting language and every namespace for it are loaded,
 * so the first render is never a flash of English for a Russian reader.
 */
export function initI18n(
  language: SupportedLanguage = resolveLanguage(readCachedLanguagePreference()),
) {
  requestedLanguage = language;
  return i18n
    .use(lazyLocales)
    .use(initReactI18next)
    .init({
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_LANGUAGES,
      load: "languageOnly",
      ns: NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      resources: { en: englishResources },
      partialBundledLanguages: true,
      // React already escapes rendered strings.
      interpolation: { escapeValue: false },
      returnEmptyString: false,
      react: { useSuspense: false },
    });
}

function requestLanguage(preference: LanguagePreference) {
  const language = resolveLanguage(preference);
  const requestMatches = requestedLanguage === language;
  const resolvedMatches = i18n.resolvedLanguage === language;
  if (requestMatches && resolvedMatches) return;

  requestedLanguage = language;
  void i18n
    .changeLanguage(language)
    .then(() => {
      const latest = requestedLanguage;
      if (latest && i18n.resolvedLanguage !== latest) {
        requestLanguage(latest);
      }
    })
    .catch(() => undefined);
}

/** Switches the live UI language without persisting an unsaved draft. */
export function previewLanguagePreference(preference: LanguagePreference) {
  requestLanguage(preference);
}

/** Caches a saved preference for the next page load and switches to it. */
export function applyLanguagePreference(preference: LanguagePreference) {
  writeCachedLanguagePreference(preference);
  requestLanguage(preference);
}

export function setLanguagePreviewDirty(dirty: boolean) {
  languagePreviewDirty = dirty;
}

export function isLanguagePreviewDirty() {
  return languagePreviewDirty;
}

// Untyped view of `t` for keys assembled at runtime. Only the two helpers
// below use it; everything else goes through the compiler-checked `t`.
function translateUnchecked(key: string, options?: Record<string, unknown>) {
  return (i18n.t as unknown as (key: string, options?: object) => string).call(
    i18n,
    key,
    options,
  );
}

/**
 * Looks up a key built at runtime (a setting key, an enum value, an API error
 * code) and returns `fallback` when English has no such key. Static keys must
 * use `t` so the compiler checks them. The calling component must itself use
 * `useTranslation()`, which is what re-renders it on a language change.
 */
export function translateKnown(
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  return i18n.exists(key) ? translateUnchecked(key, options) : fallback;
}

/**
 * Server messages are English and often more specific than their code, so
 * English readers always get the server's wording. Other languages get the
 * `errors:codes.<code>` translation when one exists, else the server text.
 */
export function apiErrorMessage(error: unknown): string {
  // Matched by shape rather than `instanceof ApiError` so this module does
  // not depend on the fetch client, which several tests replace wholesale.
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (i18n.resolvedLanguage === DEFAULT_LANGUAGE) return error.message;
    return translateKnown(`errors:codes.${error.code}`, error.message);
  }
  if (error instanceof Error && error.message) return error.message;
  return translateUnchecked("errors:generic");
}

/** Locale to pass to `Intl` and `toLocale*` in place of `undefined`. */
export function useFormatLocale(): string {
  const { i18n: instance } = useTranslation();
  return formatLocale(instance.resolvedLanguage ?? DEFAULT_LANGUAGE);
}
