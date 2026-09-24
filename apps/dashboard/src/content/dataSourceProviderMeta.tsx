// Provider presentation metadata for Data Sources: display labels, icons, and setup copy.
//
// This lives under content/ rather than in a page so that both the Data Sources page and the
// in-editor DataSourcePicker can render the same provider identity without pages/ and content/
// importing each other in a cycle.
import {
  AlertTriangle,
  Braces,
  CalendarDays,
  ClipboardList,
  CloudSun,
  Database,
  FileSpreadsheet,
  Rss,
  School,
  TableProperties,
  type LucideIcon,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { DataSourceDefinition, DataSourceProvider } from "../api/types";
import { translateKnown } from "../i18n";

type ContentT = TFunction<["content", "common"]>;

// Display names for the providers Studio knows. Values sent to or compared
// with the API (provider IDs, status strings) are never translated; only
// these presentation labels go through t().
export function providerLabel(
  provider: DataSourceProvider | null | undefined,
  t: ContentT,
) {
  if (!provider) return t("dataSources.providerNames.dataSource");
  switch (provider) {
    case "rss":
      return t("dataSources.providerNames.rss");
    case "csv":
      return t("dataSources.providerNames.csv");
    case "json":
      return t("dataSources.providerNames.json");
    case "manual":
      return t("dataSources.providerNames.manual");
    case "cap_alerts":
      return t("dataSources.providerNames.capAlerts");
    case "air_quality":
      return t("dataSources.providerNames.airQuality");
    case "calendar":
      return t("dataSources.providerNames.calendar");
    case "weather":
      return t("dataSources.providerNames.weather");
    case "transit":
      return t("dataSources.providerNames.transit");
    case "atom":
      return t("dataSources.providerNames.atom");
    case "form":
      return t("dataSources.providerNames.form");
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

// A generic icon mapping by icon identifier. Release-defined definitions declare an icon
// name; unknown identifiers fall back to a safe default so a new definition never breaks
// the gallery.
const sourceIconMap: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  csv: FileSpreadsheet,
  spreadsheet: FileSpreadsheet,
  json: Braces,
  braces: Braces,
  table: TableProperties,
  manual: TableProperties,
  cloud_sun: CloudSun,
  weather: CloudSun,
  rss: Rss,
  feed: Rss,
  alert: AlertTriangle,
  transit: CalendarDays,
  school: School,
};

export function iconForIdentifier(icon: string | undefined, size = 28) {
  const Icon = (icon && sourceIconMap[icon]) || Database;
  return <Icon size={size} />;
}

// Gallery copy for the providers that predate release-defined definitions. Their catalog
// descriptions are written for the definition compiler ("Project a public RSS feed into
// typed records"); these say the same thing to an author choosing what to connect.
const galleryCopy: Record<string, string> = {
  calendar: "Public Google, Microsoft, Apple, or other ICS calendars.",
  rss: "News, announcements, blog posts, and published updates.",
  atom: "Atom entries from publishing systems and update feeds.",
  json: "Public API data mapped with simple JSON Pointer paths.",
  csv: "Upload a spreadsheet export or connect a hosted CSV URL.",
  manual: "Maintain a small typed dataset directly in Studio.",
  weather: "Cached current conditions and daily forecasts.",
  transit: "Public GTFS departures and service alerts.",
  cap_alerts: "Active public emergency alerts and instructions.",
  air_quality: "Current AQI, pollutants, pollen, and hourly forecasts.",
  form: "Collect submissions, approve them, and publish records to Widgets.",
};

export function providerGalleryDescription(definition: DataSourceDefinition) {
  if (!definition.legacyEditor) return definition.description;
  return galleryCopy[definition.id] ?? definition.description;
}

// galleryDescriptionKey returns the locale key for a legacy provider's gallery
// blurb, or undefined when the catalog description renders as-is
// (release-defined definitions and legacy IDs without dedicated copy).
function galleryDescriptionKey(
  definition: DataSourceDefinition,
): string | undefined {
  if (!definition.legacyEditor) return undefined;
  const keys: Record<string, string> = {
    calendar: "dataSources.gallery.calendar",
    rss: "dataSources.gallery.rss",
    atom: "dataSources.gallery.atom",
    json: "dataSources.gallery.json",
    csv: "dataSources.gallery.csv",
    manual: "dataSources.gallery.manual",
    weather: "dataSources.gallery.weather",
    transit: "dataSources.gallery.transit",
    cap_alerts: "dataSources.gallery.capAlerts",
    air_quality: "dataSources.gallery.airQuality",
    form: "dataSources.gallery.form",
  };
  return keys[definition.id];
}

// galleryDescriptionText renders the gallery blurb in the interface language.
// Release-defined descriptions come from the server catalog, so they render
// as-is, exactly like the translateKnown fallback.
export function galleryDescriptionText(
  definition: DataSourceDefinition,
): string {
  const key = galleryDescriptionKey(definition);
  if (!key) return providerGalleryDescription(definition);
  return translateKnown(key, providerGalleryDescription(definition));
}

export type SetupCopy = {
  eyebrow: string;
  description: string;
  tip: string;
  steps: string[];
};

// resolveSetup returns the Studio setup copy for a Data Source. Release-defined sources use
// their catalog metadata (description and optional setup guidance); legacy providers keep
// their hardcoded editor copy.
export function resolveSetup(
  provider: DataSourceProvider,
  definition: DataSourceDefinition | undefined,
): SetupCopy {
  if (definition && !definition.legacyEditor) {
    return {
      eyebrow: definition.setup?.eyebrow ?? "Release-defined information",
      description: definition.description,
      tip: definition.setup?.tip ?? "",
      steps: definition.setup?.steps ?? [],
    };
  }
  return (
    createCopy[provider] ?? {
      eyebrow: definition?.category ?? "Data Source",
      description: definition?.description ?? "",
      tip: "",
      steps: [],
    }
  );
}

// setupCopyKeys returns the locale keys for a legacy provider's guided setup
// copy, or undefined when the provider has no dedicated copy. Steps are three
// individual keys because locale files hold strings, not arrays.
export function setupCopyKeys(provider: DataSourceProvider):
  | {
      eyebrow: string;
      description: string;
      tip: string;
      steps: [string, string, string];
    }
  | undefined {
  const bases: Record<string, string> = {
    calendar: "dataSources.setup.calendar",
    rss: "dataSources.setup.rss",
    atom: "dataSources.setup.atom",
    json: "dataSources.setup.json",
    csv: "dataSources.setup.csv",
    manual: "dataSources.setup.manual",
    weather: "dataSources.setup.weather",
    transit: "dataSources.setup.transit",
    cap_alerts: "dataSources.setup.capAlerts",
    air_quality: "dataSources.setup.airQuality",
  };
  const base = bases[provider];
  if (!base) return undefined;
  // Key paths are assembled with concatenation so the scan reads code, not copy.
  return {
    eyebrow: base + ".eyebrow",
    description: base + ".description",
    tip: base + ".tip",
    steps: [
      base + ".steps.step1",
      base + ".steps.step2",
      base + ".steps.step3",
    ],
  };
}

// localizedSetup renders the create-flow guidance in the interface language.
// Release-defined description, tip, and steps come from the server catalog and
// render as-is; only the Studio-authored fallback eyebrow is translated.
export function localizedSetup(
  provider: DataSourceProvider,
  definition: DataSourceDefinition | undefined,
): SetupCopy {
  const english = resolveSetup(provider, definition);
  if (definition && !definition.legacyEditor) {
    return {
      eyebrow:
        definition.setup?.eyebrow ??
        translateKnown("dataSources.setup.releaseEyebrow", english.eyebrow),
      description: english.description,
      tip: english.tip,
      steps: english.steps,
    };
  }
  const keys = setupCopyKeys(provider);
  if (!keys) return english;
  return {
    eyebrow: translateKnown(keys.eyebrow, english.eyebrow),
    description: translateKnown(keys.description, english.description),
    tip: translateKnown(keys.tip, english.tip),
    steps: keys.steps.map((key, index) =>
      translateKnown(key, english.steps[index] ?? ""),
    ),
  };
}

// sourceIcon prefers a release-defined definition's declared icon and falls back to the
// legacy provider icon.
export function sourceIcon(
  provider: DataSourceProvider,
  definition: DataSourceDefinition | undefined,
  size = 28,
) {
  if (definition && !definition.legacyEditor) {
    return iconForIdentifier(definition.icon, size);
  }
  return providerIcon(provider, size);
}

// createCopy keeps the legacy English: resolveSetup returns it verbatim (asserted by
// DataSourcesPage.test), while the interface renders the setup.* locale keys.
const createCopy: Record<string, SetupCopy> = {
  calendar: {
    eyebrow: "iCalendar feed", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Connect one or more public ICS calendars, choose which event details to expose, then preview real events before saving.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Use the public or secret iCalendar subscription URL, not the normal calendar webpage.",
    steps: [
      "Name the connection and paste the public ICS URL.",
      "Choose the event window, fields, and timezone.",
      "Preview real events, then save the Data Source.",
    ],
  },
  rss: {
    eyebrow: "News and updates", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Turn an RSS feed into clean, cached records for lists, tickers, tables, and layouts.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Paste the direct feed URL. It often ends in /feed, .xml, or .rss.",
    steps: [
      "Name the connection and paste the RSS feed URL.",
      "Choose the fields, item limit, and sort order.",
      "Preview the mapped posts, then save.",
    ],
  },
  atom: {
    eyebrow: "Published entries", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Turn an Atom feed into reusable records without making editors work through every technical option first.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Use the direct Atom XML URL rather than the website homepage.",
    steps: [
      "Name the connection and paste the Atom feed URL.",
      "Choose the fields, item limit, and sort order.",
      "Preview the mapped entries, then save.",
    ],
  },
  json: {
    eyebrow: "Structured API data", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Connect a public JSON endpoint, map its record paths, and verify the normalized result before saving.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: 'JSON Pointer paths begin with a slash. Use / for a top-level array or /items for { "items": [...] }.',
    steps: [
      "Paste the public JSON endpoint URL.",
      "Map the list path and the fields your Widgets need.",
      "Preview the mapped records, then save.",
    ],
  },
  csv: {
    eyebrow: "Spreadsheet data", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Upload a CSV or connect a hosted CSV, map its columns, and preview the rows Tilecast will cache.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Column names must match the first row of the CSV. Start with the title column; the others are optional.",
    steps: [
      "Upload a CSV file or paste a direct CSV URL.",
      "Map the column names and choose displayed fields.",
      "Preview the mapped rows, then save.",
    ],
  },
  manual: {
    eyebrow: "Editor-managed data", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Create a small typed table for announcements, prices, metrics, directories, and other reusable signage data.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Choose stable field keys because Widgets refer to them when selecting content.",
    steps: [
      "Define the typed columns your Widgets need.",
      "Enter up to 200 rows directly in Studio.",
      "Save and reuse the table across multiple Widgets.",
    ],
  },
  weather: {
    eyebrow: "Global forecast", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Cache current conditions and a seven-day forecast for one coordinate using MET Norway.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Use coordinates rounded to four decimals and the IANA timezone for the location.",
    steps: [
      "Enter the location label, coordinates, and timezone.",
      "Choose units and provide the required contact identity.",
      "Preview the normalized forecast, then save.",
    ],
  },
  transit: {
    eyebrow: "Public transport", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Join public GTFS schedules with realtime trip updates and optional service alerts.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Use stable stop IDs from the agency’s GTFS Static feed.",
    steps: [
      "Enter the Static and Realtime feed URLs.",
      "Choose stop IDs, route filters, and timezone.",
      "Preview departures and alerts, then save.",
    ],
  },
  cap_alerts: {
    eyebrow: "Public warnings", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Normalize active public CAP 1.2 warnings from direct XML or a feed index.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Area filters match the alert’s published area description.",
    steps: [
      "Enter the CAP document or index URL.",
      "Choose language, severity, and area filters.",
      "Preview active alerts, then save.",
    ],
  },
  air_quality: {
    eyebrow: "Environmental conditions", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    description:
      "Cache current AQI and hourly pollutant forecasts for one location.", // i18n-ignore: legacy English asserted by DataSourcesPage.test
    tip: "Hosted Open-Meteo access requires noncommercial acknowledgement; commercial deployments use a self-hosted endpoint.",
    steps: [
      "Enter the location coordinates and timezone.",
      "Choose AQI standard and measurements.",
      "Confirm endpoint policy, preview, then save.",
    ],
  },
};

export function providerIcon(provider: DataSourceProvider, size = 28) {
  if (provider === "calendar") return <CalendarDays size={size} />;
  if (provider === "csv") return <FileSpreadsheet size={size} />;
  if (provider === "json") return <Braces size={size} />;
  if (provider === "manual") return <TableProperties size={size} />;
  if (provider === "weather") return <CloudSun size={size} />;
  if (provider === "air_quality") return <CloudSun size={size} />;
  if (provider === "transit") return <CalendarDays size={size} />;
  if (provider === "cap_alerts") return <Rss size={size} />;
  if (provider === "form") return <ClipboardList size={size} />;
  return <Rss size={size} />;
}
