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
import {
  DEFAULT_NAMESPACE,
  NAMESPACES,
  PLUGIN_NAMESPACES,
  englishResources,
  pluginEnglishResources,
} from "./resources";

export * from "./languages";
export { NAMESPACES, type Namespace } from "./resources";

// Non-English locales are split into their own chunks and fetched only when
// that language is chosen, so English installations download no translations.
const localeLoaders = import.meta.glob<{ default: Record<string, unknown> }>([
  "../locales/*/*.json",
  "!../locales/en/*.json",
  "../../../../plugins/*/studio/locales/*.json",
  "!../../../../plugins/*/studio/locales/en.json",
]);

function localePath(language: string, namespace: string) {
  if (namespace.startsWith("plugin.")) {
    const directory = namespace.slice("plugin.".length).replaceAll("_", "-");
    return `../../../../plugins/${directory}/studio/locales/${language}.json`;
  }
  return `../locales/${language}/${namespace}.json`;
}

const lazyLocales: BackendModule = {
  type: "backend",
  init: () => undefined,
  read(language, namespace, callback) {
    const load = localeLoaders[localePath(language, namespace)];
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

const rightToLeftScripts = new Set([
  "Adlm",
  "Arab",
  "Hebr",
  "Nkoo",
  "Rohg",
  "Syrc",
  "Thaa",
]);
const rightToLeftLanguages = new Set([
  "ar",
  "ckb",
  "dv",
  "fa",
  "he",
  "ks",
  "ku",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);

/** Resolve text direction independently from whether Studio ships translations. */
export function directionForLocale(localeTag: string): "ltr" | "rtl" {
  const parts = localeTag.split("-");
  const language = parts[0]?.toLowerCase() ?? "";
  const explicitScript = parts.find((part) => /^[A-Za-z]{4}$/.test(part));
  const canonicalScript = explicitScript
    ? `${explicitScript.slice(0, 1).toUpperCase()}${explicitScript.slice(1).toLowerCase()}`
    : undefined;
  try {
    const locale = new Intl.Locale(localeTag) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
    };
    const direction = locale.getTextInfo?.().direction;
    if (direction === "ltr" || direction === "rtl") return direction;
    const script = canonicalScript ?? locale.maximize().script;
    if (script) return rightToLeftScripts.has(script) ? "rtl" : "ltr";
  } catch {
    if (canonicalScript)
      return rightToLeftScripts.has(canonicalScript) ? "rtl" : "ltr";
  }
  return rightToLeftLanguages.has(language) ? "rtl" : "ltr";
}

/** Set root language metadata for assistive technology and direction-aware CSS. */
export function setDocumentLanguage(
  localeTag: string,
  root?: Pick<HTMLElement, "lang" | "dir">,
) {
  const element =
    root ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  if (!element) return;
  element.lang = localeTag;
  element.dir = directionForLocale(localeTag);
}

i18n.on("languageChanged", (language) => {
  setDocumentLanguage(language);
});

/**
 * Resolves once the starting language and every namespace for it are loaded,
 * so the first render is never a flash of English for a Russian reader.
 */
export function initI18n(
  language: SupportedLanguage = resolveLanguage(readCachedLanguagePreference()),
) {
  return i18n
    .use(lazyLocales)
    .use(initReactI18next)
    .init({
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_LANGUAGES,
      load: "languageOnly",
      ns: [...NAMESPACES, ...PLUGIN_NAMESPACES],
      defaultNS: DEFAULT_NAMESPACE,
      resources: { en: { ...englishResources, ...pluginEnglishResources } },
      partialBundledLanguages: true,
      // React already escapes rendered strings.
      interpolation: { escapeValue: false },
      returnEmptyString: false,
      react: { useSuspense: false },
    });
}

/** Caches the preference for the next page load and switches if it differs. */
export function applyLanguagePreference(preference: LanguagePreference) {
  writeCachedLanguagePreference(preference);
  const language = resolveLanguage(preference);
  if (i18n.resolvedLanguage !== language) void i18n.changeLanguage(language);
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
