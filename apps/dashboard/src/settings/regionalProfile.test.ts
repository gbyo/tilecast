import { describe, expect, it } from "vitest";
import {
  defaultAirQualityStandard,
  defaultWeatherUnits,
  isISO4217CurrencyCode,
  organizationRegionalProfile,
  regionForLocale,
} from "./regionalProfile";

describe("organization regional defaults", () => {
  it.each([
    ["en-US", "US"],
    ["en-GB", "GB"],
    ["de-DE", "DE"],
    ["es-ES", "ES"],
    ["ru-RU", "RU"],
    ["ja-JP", "JP"],
  ])("derives %s as region %s", (locale, region) => {
    expect(regionForLocale(locale)).toBe(region);
  });

  it("uses the organization timezone and formatting settings", () => {
    expect(
      organizationRegionalProfile({
        "organization.locale": "de-de",
        "organization.timezone": "Europe/Berlin",
        "organization.date_format": "dd/MM/yyyy",
        "organization.time_format": "24-hour",
      }),
    ).toEqual({
      locale: "de-DE",
      timezone: "Europe/Berlin",
      region: "DE",
      dateFormat: "dd/MM/yyyy",
      timeFormat: "24-hour",
    });
  });

  it("uses Celsius outside the US, including the UK", () => {
    expect(defaultWeatherUnits("US")).toBe("imperial");
    expect(defaultWeatherUnits("GB")).toBe("metric");
    expect(defaultWeatherUnits("DE")).toBe("metric");
    expect(defaultWeatherUnits("JP")).toBe("metric");
  });

  it("validates explicit semantic currency codes without inferring one", () => {
    expect(isISO4217CurrencyCode("eur")).toBe(true);
    expect(isISO4217CurrencyCode("JPY")).toBe(true);
    expect(isISO4217CurrencyCode("ABC")).toBe(false);
    expect(isISO4217CurrencyCode("XXX")).toBe(false);
  });

  it("defaults AQI only for regions with a defensible standard", () => {
    expect(defaultAirQualityStandard("US")).toBe("us");
    expect(defaultAirQualityStandard("DE")).toBe("european");
    expect(defaultAirQualityStandard("ES")).toBe("european");
    expect(defaultAirQualityStandard("GB")).toBeUndefined();
    expect(defaultAirQualityStandard("RU")).toBeUndefined();
    expect(defaultAirQualityStandard("JP")).toBeUndefined();
  });
});
