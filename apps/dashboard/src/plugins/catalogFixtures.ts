import type {
  GitHubInstallReview,
  InstalledPackage,
  PackageUpdateCheck,
  PluginStoreCustom,
  PluginStoreMarketplace,
  PluginSummary,
} from "../api/types";

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

/** A marketplace listing in the server's shape, for tests. */
export function marketplaceListing(
  overrides: Partial<PluginStoreMarketplace> = {},
): PluginStoreMarketplace {
  return {
    version: "1.0.0",
    // i18n-ignore: development fixture label, not Studio copy
    name: "Weather",
    // i18n-ignore: development fixture label, not Studio copy
    description: "Current conditions.",
    publisherId: "acme",
    // i18n-ignore: development fixture label, not Studio copy
    publisherName: "Acme",
    // i18n-ignore: development fixture value, not Studio copy
    license: "MIT",
    tilecastRange: ">=0.0.0",
    // i18n-ignore: development fixture value, not Studio copy
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    repository: "https://github.com/acme/tilecast-weather",
    documentation: "https://example.com/acme/weather/docs",
    issues: "https://github.com/acme/tilecast-weather/issues",
    compatible: true,
    installed: false,
    updateAvailable: false,
    ...overrides,
  };
}

/** A custom store entry in the server's shape, for tests. */
export function customPackage(
  overrides: Partial<PluginStoreCustom> = {},
): PluginStoreCustom {
  return {
    version: "1.2.0",
    // i18n-ignore: development fixture label, not Studio copy
    name: "Lobby Kiosk",
    // i18n-ignore: development fixture label, not Studio copy
    description: "A kiosk from your own repository.",
    publisherId: "acme",
    // i18n-ignore: development fixture label, not Studio copy
    publisherName: "Acme",
    // i18n-ignore: development fixture value, not Studio copy
    license: "MIT",
    tilecastRange: ">=0.0.0",
    // i18n-ignore: development fixture value, not Studio copy
    digest:
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    compatible: true,
    installed: false,
    ...overrides,
  };
}

/** An installed package in the server's shape, for tests. */
export function installedPackage(
  overrides: Partial<InstalledPackage> = {},
): InstalledPackage {
  return {
    packageId: "acme.kiosk",
    version: "1.2.0",
    manifest: {
      // i18n-ignore: development fixture label, not Studio copy
      name: "Lobby Kiosk",
      // i18n-ignore: development fixture label, not Studio copy
      description: "A kiosk from your own repository.",
      publisherId: "acme",
      // i18n-ignore: development fixture label, not Studio copy
      publisherName: "Acme",
      // i18n-ignore: development fixture value, not Studio copy
      license: "MIT",
      tilecastRange: ">=0.0.0",
    },
    // i18n-ignore: development fixture value, not Studio copy
    digest:
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    sourceKind: "custom",
    sourceReference: "https://github.com/acme/tilecast-kiosk",
    registryReference: "ghcr.io/acme/tilecast-kiosk",
    signerIdentity: "https://github.com/acme/tilecast-kiosk",
    trust: "verified",
    installedAt: "2026-09-01T12:00:00Z",
    installedBy: null,
    activatedAt: "2026-09-01T12:00:00Z",
    hasRollback: false,
    contributions: [{ kind: "widget", id: "acme.kiosk.lobby", path: "lobby" }],
    source: {
      owner: "acme",
      name: "tilecast-kiosk",
      repositoryUrl: "https://github.com/acme/tilecast-kiosk",
      // i18n-ignore: development fixture value, not Studio copy
      resolvedDigest:
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      resolvedAt: "2026-09-01T12:00:00Z",
      addedAt: "2026-09-01T12:00:00Z",
    },
    ...overrides,
  };
}

/** An install review in the server's shape, for tests. */
export function installReview(
  overrides: Partial<GitHubInstallReview> = {},
): GitHubInstallReview {
  return {
    packageId: "acme.kiosk",
    version: "1.2.0",
    manifest: {
      // i18n-ignore: development fixture label, not Studio copy
      name: "Lobby Kiosk",
      // i18n-ignore: development fixture label, not Studio copy
      description: "A kiosk from your own repository.",
      publisherId: "acme",
      // i18n-ignore: development fixture label, not Studio copy
      publisherName: "Acme",
      // i18n-ignore: development fixture value, not Studio copy
      license: "MIT",
      tilecastRange: ">=0.0.0",
    },
    compatible: true,
    contributions: [{ type: "widget", path: "lobby" }],
    // i18n-ignore: development fixture value, not Studio copy
    digest:
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    registry: "ghcr.io/acme/tilecast-kiosk",
    releaseTag: "v1.2.0",
    // i18n-ignore: development fixture label, not Studio copy
    releaseName: "Lobby Kiosk 1.2",
    publishedAt: "2026-09-01T12:00:00Z",
    owner: "acme",
    repo: "tilecast-kiosk",
    repositoryUrl: "https://github.com/acme/tilecast-kiosk",
    signer: "https://github.com/acme/tilecast-kiosk",
    trust: "verified",
    installed: false,
    ...overrides,
  };
}

/** An update check in the server's shape, for tests. */
export function updateCheck(
  overrides: Partial<PackageUpdateCheck> = {},
): PackageUpdateCheck {
  return {
    installed: installedPackage(),
    available: false,
    upToDate: true,
    lastChecked: "2026-09-02T12:00:00Z",
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
};
