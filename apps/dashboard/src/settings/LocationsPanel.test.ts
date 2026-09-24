import { describe, expect, it } from "vitest";
import enSettings from "../locales/en/settings.json";
import esSettings from "../locales/es/settings.json";
import ruSettings from "../locales/ru/settings.json";
import { formatLocationAddress } from "./LocationsPanel";

describe("international location presentation", () => {
  it("keeps locality, administrative area, postal code, and country neutral", () => {
    expect(
      formatLocationAddress({
        addressLine1: "1-2-3 Jingūmae",
        city: "渋谷区",
        state: "東京都",
        postalCode: "150-0001",
        country: "日本",
      }),
    ).toBe("1-2-3 Jingūmae · 渋谷区 · 東京都 · 150-0001 · 日本");
  });

  it("renders partial addresses without assuming postal code or region", () => {
    expect(formatLocationAddress({ city: "Malmö", country: "Sweden" })).toBe(
      "Malmö · Sweden",
    );
    expect(
      formatLocationAddress({ city: "Paris", state: "Île-de-France" }),
    ).toBe("Paris · Île-de-France");
  });

  it("uses region-neutral address field labels in every Studio catalog", () => {
    for (const catalog of [enSettings, esSettings, ruSettings]) {
      expect(catalog.locations.fields.city).not.toMatch(
        /^City$|^Ciudad$|^Город$/,
      );
      expect(catalog.locations.fields.state).toMatch(
        /province|provincia|провинц/i,
      );
      expect(catalog.locations.fields.postal).not.toMatch(/ZIP/i);
    }
  });
});
