import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { canonicalizeLocale, isValidTimezone } from "./settingValues";

const europeanAqiRegions = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export type AirQualityStandard = "us" | "european";

export function isISO4217CurrencyCode(value: string): boolean {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === "XXX") return false;
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "currency") => string[];
  };
  if (typeof intl.supportedValuesOf === "function")
    return intl.supportedValuesOf("currency").includes(code);
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

export function regionForLocale(value: unknown): string | undefined {
  const localeTag = canonicalizeLocale(value);
  if (!localeTag || typeof Intl.Locale !== "function") return undefined;
  try {
    const locale = new Intl.Locale(localeTag);
    return locale.region ?? locale.maximize().region ?? undefined;
  } catch {
    return undefined;
  }
}

export function defaultWeatherUnits(region?: string): "metric" | "imperial" {
  // The weather provider only supports metric or imperial. Celsius is the safe
  // general default; the UK stays metric despite using miles in some contexts.
  return region === "US" ? "imperial" : "metric";
}

export function defaultAirQualityStandard(
  region?: string,
): AirQualityStandard | undefined {
  if (region === "US") return "us";
  if (region && europeanAqiRegions.has(region)) return "european";
  return undefined;
}

export type OrganizationRegionalProfile = {
  locale?: string;
  timezone: string;
  region?: string;
  dateFormat?: string;
  timeFormat?: string;
};

export function organizationRegionalProfile(
  values?: Record<string, unknown>,
): OrganizationRegionalProfile {
  const locale =
    canonicalizeLocale(values?.["organization.locale"]) ?? undefined;
  const configuredTimezone = values?.["organization.timezone"];
  const timezone =
    typeof configuredTimezone === "string" &&
    isValidTimezone(configuredTimezone)
      ? configuredTimezone
      : "UTC";
  return {
    locale,
    timezone,
    region: regionForLocale(locale),
    dateFormat:
      typeof values?.["organization.date_format"] === "string"
        ? values["organization.date_format"]
        : undefined,
    timeFormat:
      typeof values?.["organization.time_format"] === "string"
        ? values["organization.time_format"]
        : undefined,
  };
}

export function useOrganizationRegionalProfile() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return {
    ...organizationRegionalProfile(settings.data?.values),
    ready: !settings.isLoading,
  };
}
