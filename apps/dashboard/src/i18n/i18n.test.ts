// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  apiErrorMessage,
  applyLanguagePreference,
  detectBrowserLanguage,
  formatLocale,
  i18n,
  readCachedLanguagePreference,
  resolveLanguage,
  translateKnown,
} from ".";

afterEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("language resolution", () => {
  it("matches the first shipped browser language on its primary subtag", () => {
    expect(detectBrowserLanguage(["de-DE", "es-MX", "ru"])).toBe("es");
    expect(detectBrowserLanguage(["RU-ru"])).toBe("ru");
    expect(detectBrowserLanguage(["de", "fr"])).toBe("en");
    expect(detectBrowserLanguage([])).toBe("en");
  });

  it("uses an explicit preference over the browser", () => {
    expect(resolveLanguage("ru", ["es"])).toBe("ru");
    expect(resolveLanguage("system", ["es"])).toBe("es");
  });

  it("keeps the browser's region only when it shares the interface language", () => {
    expect(formatLocale("en", ["en-GB", "ru-RU"])).toBe("en-GB");
    expect(formatLocale("ru", ["en-GB", "ru-RU"])).toBe("ru-RU");
    expect(formatLocale("es", ["en-GB"])).toBe("es");
  });

  it("ignores an unrecognized cached value", () => {
    window.localStorage.setItem("tilecast.language", "klingon");
    expect(readCachedLanguagePreference()).toBe("system");
  });
});

describe("i18n instance", () => {
  it("loads a translation chunk on demand and marks the document language", async () => {
    await i18n.changeLanguage("ru");
    expect(i18n.t("actions.save")).toBe("Сохранить");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("selects every Russian plural category", async () => {
    await i18n.changeLanguage("ru");
    expect(i18n.t("count.items", { count: 1 })).toBe("1 элемент");
    expect(i18n.t("count.items", { count: 3 })).toBe("3 элемента");
    expect(i18n.t("count.items", { count: 5 })).toBe("5 элементов");
    expect(i18n.t("count.items", { count: 21 })).toBe("21 элемент");
  });

  it("caches an applied preference for the next page load", async () => {
    applyLanguagePreference("es");
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("es"));
    expect(readCachedLanguagePreference()).toBe("es");
  });

  it("falls back for runtime keys English does not define", async () => {
    await i18n.changeLanguage("es");
    expect(translateKnown("errors:codes.rate_limited", "fallback")).toMatch(
      /Demasiados intentos/,
    );
    expect(translateKnown("errors:codes.not_a_code", "fallback")).toBe(
      "fallback",
    );
  });
});

describe("apiErrorMessage", () => {
  const error = new ApiError(
    "Too many sign-in attempts from this address.",
    429,
    "rate_limited",
  );

  it("keeps the server's specific wording for English readers", () => {
    expect(apiErrorMessage(error)).toBe(
      "Too many sign-in attempts from this address.",
    );
  });

  it("translates known codes and keeps the server text for unknown ones", async () => {
    await i18n.changeLanguage("ru");
    expect(apiErrorMessage(error)).toMatch(/Слишком много попыток/);
    expect(
      apiErrorMessage(new ApiError("Exact reason.", 400, "odd_code")),
    ).toBe("Exact reason.");
    expect(apiErrorMessage("not an error")).toBe(
      "Что-то пошло не так. Повторите попытку.",
    );
  });
});
