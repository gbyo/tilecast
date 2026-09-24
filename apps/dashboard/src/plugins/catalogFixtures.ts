import type { PluginSummary } from "../api/types";

/** A catalog entry in the server's shape, for tests. */
export function catalogPlugin(
  overrides: Partial<PluginSummary> & Pick<PluginSummary, "id">,
): PluginSummary {
  const base = catalogDefaults[overrides.id];
  return {
    version: 1,
    name: overrides.id,
    // i18n-ignore: development fixture fallback, not Studio copy
    description: "A plugin.",
    category: "Display",
    icon: "puzzle",
    managementPath: `/plugins/${overrides.id}`,
    instanceNounSingular: "instance",
    instanceNounPlural: "instances",
    requirements: [],
    capabilities: [],
    installed: true,
    installable: true,
    configured: false,
    active: false,
    instanceCount: 0,
    attention: [],
    ...base,
    ...overrides,
  };
}

const catalogDefaults: Record<string, Partial<PluginSummary>> = {
  countdown_bar: {
    name: "Countdown Bar",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Show a timed bottom bar.",
    category: "Display",
    icon: "clock",
    managementPath: "/plugins/countdown-bar",
  },
  emergency_alerts: {
    name: "Emergency Alerts",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Watch official NWS weather alerts.",
    category: "Automation",
    icon: "siren",
    managementPath: "/plugins/emergency-alerts",
    instanceNounSingular: "alert rule",
    instanceNounPlural: "alert rules",
    requirements: [
      // i18n-ignore: development fixture label, not Studio copy
      { kind: "region", label: "United States" },
      // i18n-ignore: development fixture label, not Studio copy
      { kind: "network", label: "Internet access from Tilecast Server" },
    ],
    capabilities: ["Background NWS polling"],
  },
  forms: {
    name: "Forms",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Collect submissions.",
    category: "Workflow",
    icon: "clipboard-list",
    managementPath: "/plugins/forms",
    instanceNounSingular: "form",
    instanceNounPlural: "forms",
  },
  brand_bug: {
    name: "Brand Bug / Watermark",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Keep a corner mark over content.",
    category: "Display",
    icon: "stamp",
    managementPath: "/plugins/brand-bug",
    instanceNounSingular: "mark",
    instanceNounPlural: "marks",
  },
  noise_meter: {
    name: "Noise Meter",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Watch room noise on Linux players.",
    category: "Hardware",
    icon: "audio-lines",
    managementPath: "/plugins/noise-meter",
    instanceNounSingular: "meter",
    instanceNounPlural: "meters",
    requirements: [
      // i18n-ignore: development fixture label, not Studio copy
      { kind: "platform", label: "Linux Player" },
      // i18n-ignore: development fixture label, not Studio copy
      { kind: "hardware", label: "Microphone or audio input" },
    ],
    capabilities: ["Player microphone"],
  },
};
