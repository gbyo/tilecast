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
import enContent from "../locales/en/content.json";

export type ContentT = TFunction<"content", undefined>;

export function providerLabel(
  provider: DataSourceProvider | null | undefined,
  t?: ContentT,
) {
  if (!provider)
    return t?.("sources.providerLabels.dataSource") ?? "Data Source";
  if (provider === "manual")
    return t?.("sources.providerLabels.manualTable") ?? "Manual Table";
  if (provider === "cap_alerts")
    return t?.("sources.providerLabels.capAlerts") ?? "CAP Alerts";
  if (provider === "air_quality")
    return t?.("sources.providerLabels.airQuality") ?? "Air Quality";
  return (
    (
      {
        rss: "RSS",
        csv: "CSV",
        json: "JSON",
      } as Record<string, string>
    )[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
  );
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
const galleryKeys = {
  calendar: "sources.gallery.calendar",
  rss: "sources.gallery.rss",
  atom: "sources.gallery.atom",
  json: "sources.gallery.json",
  csv: "sources.gallery.csv",
  manual: "sources.gallery.manual",
  weather: "sources.gallery.weather",
  transit: "sources.gallery.transit",
  cap_alerts: "sources.gallery.capAlerts",
  air_quality: "sources.gallery.airQuality",
  form: "sources.gallery.form",
} as const;

function galleryKeyFor(id: string) {
  switch (id) {
    case "calendar":
      return galleryKeys.calendar;
    case "rss":
      return galleryKeys.rss;
    case "atom":
      return galleryKeys.atom;
    case "json":
      return galleryKeys.json;
    case "csv":
      return galleryKeys.csv;
    case "manual":
      return galleryKeys.manual;
    case "weather":
      return galleryKeys.weather;
    case "transit":
      return galleryKeys.transit;
    case "cap_alerts":
      return galleryKeys.cap_alerts;
    case "air_quality":
      return galleryKeys.air_quality;
    case "form":
      return galleryKeys.form;
    default:
      return undefined;
  }
}

export function providerGalleryDescription(
  definition: DataSourceDefinition,
  t?: ContentT,
) {
  if (!definition.legacyEditor) return definition.description;
  const key = galleryKeyFor(definition.id);
  if (!key) return definition.description;
  if (t) return t(key);
  // English fallback for callers that have not been converted yet. Converted
  // surfaces pass `t` and never read the bundled English copy.
  const fallback = enContent.sources.gallery as Record<string, string>;
  return fallback[sectionId(definition.id)] ?? definition.description;
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
// Locale section names are camelCase while provider ids use snake_case.
function sectionId(id: string): string {
  if (id === "cap_alerts") return "capAlerts";
  if (id === "air_quality") return "airQuality";
  return id;
}

export function resolveSetup(
  provider: DataSourceProvider,
  definition: DataSourceDefinition | undefined,
  t?: ContentT,
): SetupCopy {
  if (definition && !definition.legacyEditor) {
    return {
      eyebrow:
        definition.setup?.eyebrow ??
        t?.("sources.createFlow.releaseInfo") ??
        "Release-defined information",
      description: definition.description,
      tip: definition.setup?.tip ?? "",
      steps: definition.setup?.steps ?? [],
    };
  }
  if (t) {
    const keys = setupKeysFor(provider);
    if (keys)
      return {
        eyebrow: t(keys.eyebrow),
        description: t(keys.description),
        tip: t(keys.tip),
        steps: keys.steps.map((step) => t(step)),
      };
  } else {
    // English fallback for callers that have not been converted yet. Converted
    // surfaces pass `t` and never read the bundled English copy.
    const sections = enContent.sources.setup as Record<
      string,
      | {
          eyebrow: string;
          description: string;
          tip: string;
          step1: string;
          step2: string;
          step3: string;
        }
      | undefined
    >;
    const section = sections[sectionId(provider)];
    if (section)
      return {
        eyebrow: section.eyebrow,
        description: section.description,
        tip: section.tip,
        steps: [section.step1, section.step2, section.step3],
      };
  }
  return {
    eyebrow: definition?.category ?? "Data Source",
    description: definition?.description ?? "",
    tip: "",
    steps: [],
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

const setupKeys = {
  calendar: {
    eyebrow: "sources.setup.calendar.eyebrow",
    description: "sources.setup.calendar.description",
    tip: "sources.setup.calendar.tip",
    steps: [
      "sources.setup.calendar.step1",
      "sources.setup.calendar.step2",
      "sources.setup.calendar.step3",
    ],
  },
  rss: {
    eyebrow: "sources.setup.rss.eyebrow",
    description: "sources.setup.rss.description",
    tip: "sources.setup.rss.tip",
    steps: [
      "sources.setup.rss.step1",
      "sources.setup.rss.step2",
      "sources.setup.rss.step3",
    ],
  },
  atom: {
    eyebrow: "sources.setup.atom.eyebrow",
    description: "sources.setup.atom.description",
    tip: "sources.setup.atom.tip",
    steps: [
      "sources.setup.atom.step1",
      "sources.setup.atom.step2",
      "sources.setup.atom.step3",
    ],
  },
  json: {
    eyebrow: "sources.setup.json.eyebrow",
    description: "sources.setup.json.description",
    tip: "sources.setup.json.tip",
    steps: [
      "sources.setup.json.step1",
      "sources.setup.json.step2",
      "sources.setup.json.step3",
    ],
  },
  csv: {
    eyebrow: "sources.setup.csv.eyebrow",
    description: "sources.setup.csv.description",
    tip: "sources.setup.csv.tip",
    steps: [
      "sources.setup.csv.step1",
      "sources.setup.csv.step2",
      "sources.setup.csv.step3",
    ],
  },
  manual: {
    eyebrow: "sources.setup.manual.eyebrow",
    description: "sources.setup.manual.description",
    tip: "sources.setup.manual.tip",
    steps: [
      "sources.setup.manual.step1",
      "sources.setup.manual.step2",
      "sources.setup.manual.step3",
    ],
  },
  weather: {
    eyebrow: "sources.setup.weather.eyebrow",
    description: "sources.setup.weather.description",
    tip: "sources.setup.weather.tip",
    steps: [
      "sources.setup.weather.step1",
      "sources.setup.weather.step2",
      "sources.setup.weather.step3",
    ],
  },
  transit: {
    eyebrow: "sources.setup.transit.eyebrow",
    description: "sources.setup.transit.description",
    tip: "sources.setup.transit.tip",
    steps: [
      "sources.setup.transit.step1",
      "sources.setup.transit.step2",
      "sources.setup.transit.step3",
    ],
  },
  capAlerts: {
    eyebrow: "sources.setup.capAlerts.eyebrow",
    description: "sources.setup.capAlerts.description",
    tip: "sources.setup.capAlerts.tip",
    steps: [
      "sources.setup.capAlerts.step1",
      "sources.setup.capAlerts.step2",
      "sources.setup.capAlerts.step3",
    ],
  },
  airQuality: {
    eyebrow: "sources.setup.airQuality.eyebrow",
    description: "sources.setup.airQuality.description",
    tip: "sources.setup.airQuality.tip",
    steps: [
      "sources.setup.airQuality.step1",
      "sources.setup.airQuality.step2",
      "sources.setup.airQuality.step3",
    ],
  },
} as const;

function setupKeysFor(provider: DataSourceProvider) {
  switch (provider) {
    case "calendar":
      return setupKeys.calendar;
    case "rss":
      return setupKeys.rss;
    case "atom":
      return setupKeys.atom;
    case "json":
      return setupKeys.json;
    case "csv":
      return setupKeys.csv;
    case "manual":
      return setupKeys.manual;
    case "weather":
      return setupKeys.weather;
    case "transit":
      return setupKeys.transit;
    case "cap_alerts":
      return setupKeys.capAlerts;
    case "air_quality":
      return setupKeys.airQuality;
    default:
      return undefined;
  }
}

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
