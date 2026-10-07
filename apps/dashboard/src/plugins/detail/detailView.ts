import type {
  PackageCapabilities,
  PluginStoreEntry,
  PluginStoreScreenshot,
  PluginStoreSource,
  PluginSummary,
} from "../../api/types";
import { hasStudioRoute } from "../pluginCatalog";

export type DetailSourceKind = "included" | "marketplace" | "custom";

/**
 * One store entry, normalized across the included, marketplace, and custom
 * sources so the detail page never branches on which block is present.
 * Source-specific knowledge stops here and in the few places that render
 * source-specific wording.
 */
export type PluginDetailViewModel = {
  packageId: string;
  sourceKind: DetailSourceKind;
  source: PluginStoreSource;
  name: string;
  description: string;
  /**
   * Optional longer plain text. About shows it and falls back to the short
   * description without it.
   */
  longDescription?: string;
  /**
   * Who builds it. Included plugins are built by Tilecast; an external
   * package names only the publisher its catalog or manifest gives.
   */
  publisher?: string;
  /** Present for included plugins, whose icon Studio ships. */
  plugin?: PluginSummary;
  iconUrl?: string;
  screenshots: PluginStoreScreenshot[];
  categories: string[];
  installed: boolean;
  installedVersion?: string;
  version?: string;
  updateAvailable: boolean;
  compatible: boolean;
  tilecastRange?: string;
  license?: string;
  digest?: string;
  repository?: string;
  documentation?: string;
  issues?: string;
  /** True for marketplace and custom packages, which install from a registry. */
  external: boolean;
};

/** Entries without any detail block carry nothing to show. */
export function buildDetailView(
  entry: PluginStoreEntry,
): PluginDetailViewModel | null {
  const { plugin, marketplace, custom } = entry;
  if (plugin) {
    return {
      packageId: entry.packageId,
      sourceKind: "included",
      source: entry.source,
      name: plugin.name,
      description: plugin.description,
      // i18n-ignore: product name, not translated copy
      publisher: "Tilecast",
      plugin,
      screenshots: [],
      categories: [plugin.category],
      installed: plugin.installed,
      updateAvailable: false,
      compatible: true,
      documentation: plugin.documentation,
      external: false,
    };
  }
  if (marketplace) {
    return {
      packageId: entry.packageId,
      sourceKind: "marketplace",
      source: entry.source,
      name: marketplace.name,
      description: marketplace.description ?? "",
      longDescription: marketplace.longDescription,
      publisher: marketplace.publisherName,
      iconUrl: marketplace.artwork?.iconUrl,
      screenshots: marketplace.artwork?.screenshots ?? [],
      categories: marketplace.categories ?? [],
      installed: marketplace.installed,
      installedVersion: marketplace.installedVersion,
      version: marketplace.version,
      updateAvailable: marketplace.updateAvailable,
      compatible: marketplace.compatible,
      tilecastRange: marketplace.tilecastRange,
      license: marketplace.license,
      digest: marketplace.digest,
      repository: marketplace.repository,
      documentation: marketplace.documentation,
      issues: marketplace.issues,
      external: true,
    };
  }
  if (custom) {
    return {
      packageId: entry.packageId,
      sourceKind: "custom",
      source: entry.source,
      name: custom.name,
      description: custom.description ?? "",
      publisher: custom.publisherName,
      screenshots: [],
      categories: [],
      installed: custom.installed,
      installedVersion: custom.installedVersion,
      version: custom.version,
      updateAvailable: false,
      compatible: custom.compatible,
      tilecastRange: custom.tilecastRange,
      license: custom.license,
      digest: custom.digest,
      repository: entry.source.repository,
      external: true,
    };
  }
  return null;
}

/** Case, spacing, and trailing punctuation never make a description new. */
function comparable(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!…。]+$/u, "")
    .trim();
}

/**
 * The paragraphs About shows. The hero already carries the short
 * description, so About exists only for a long description that adds
 * something to it; restating the short text would just repeat it.
 */
export function aboutParagraphs(view: PluginDetailViewModel): string[] {
  const long = view.longDescription?.trim() ?? "";
  if (long === "" || comparable(long) === comparable(view.description)) {
    return [];
  }
  return long.split(/\n{2,}/).filter((part) => part.trim() !== "");
}

/**
 * What the hero and the status card offer as the one primary action. An
 * installed package shows status instead of a disabled button; an
 * incompatible package keeps its action, disabled, so the reason stays
 * attached to something the person tried to do.
 */
export type PrimaryAction =
  | { kind: "none" }
  | { kind: "installed" }
  | { kind: "open"; to: string }
  | { kind: "install"; disabled: boolean }
  | { kind: "review"; disabled: boolean };

export function primaryAction(
  view: PluginDetailViewModel,
  canInstall: boolean,
): PrimaryAction {
  const { plugin } = view;
  if (plugin) {
    if (plugin.installed) {
      return hasStudioRoute(plugin.managementPath)
        ? { kind: "open", to: plugin.managementPath }
        : { kind: "installed" };
    }
    return canInstall && plugin.installable
      ? { kind: "install", disabled: false }
      : { kind: "none" };
  }
  if (view.installed) return { kind: "installed" };
  if (!canInstall) return { kind: "none" };
  const disabled = !view.compatible;
  return view.sourceKind === "marketplace"
    ? { kind: "review", disabled }
    : { kind: "install", disabled };
}

/** The installed package's contributions and the review's share this shape. */
export type ContributionRow = {
  key: string;
  kind: string;
  name: string;
  path: string;
  id?: string;
};

/**
 * Contribution names come from the package path, which is all a manifest
 * names: `./widgets/sports-scores` reads "Sports scores".
 */
export function contributionName(path: string) {
  const segment =
    path
      .replace(/^\.\//, "")
      .split("/")
      .filter((part) => part !== "")
      .pop() ?? path;
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (words === "") return path;
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

export function contributionRows(
  items: { kind: string; path: string; id?: string }[],
): ContributionRow[] {
  return items.map((item) => ({
    key: `${item.kind} ${item.path} ${item.id ?? ""}`,
    kind: item.kind,
    name: contributionName(item.path),
    path: item.path,
    id: item.id,
  }));
}

/**
 * One reviewed capability, as structured data. Components turn it into
 * wording, so the manifest's own fields never reach a person undecoded.
 */
export type CapabilityRow =
  | { kind: "network"; hosts: string[] }
  | { kind: "storage" }
  | { kind: "background"; jobs: { id: string; intervalMinutes: number }[] }
  | { kind: "studioUI" };

export function capabilityRows(
  capabilities: PackageCapabilities | undefined,
): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  if (capabilities?.network) {
    rows.push({ kind: "network", hosts: capabilities.network.hosts });
  }
  if (capabilities?.storage === true) rows.push({ kind: "storage" });
  if (capabilities?.background) {
    rows.push({ kind: "background", jobs: capabilities.background.jobs });
  }
  if (capabilities?.studioUI) rows.push({ kind: "studioUI" });
  return rows;
}

export type CapabilityChange = {
  before: CapabilityRow;
  after: CapabilityRow;
};

/**
 * How an update changes what a package may do. A capability that is
 * present on both sides but differs in its hosts or jobs is a change, not
 * an addition, so a widened host list never hides behind an unchanged row.
 */
export function diffCapabilities(
  before: PackageCapabilities | undefined,
  after: PackageCapabilities | undefined,
): {
  added: CapabilityRow[];
  removed: CapabilityRow[];
  changed: CapabilityChange[];
} {
  const previous = new Map(
    capabilityRows(before).map((row) => [row.kind, row] as const),
  );
  const next = new Map(
    capabilityRows(after).map((row) => [row.kind, row] as const),
  );
  const added: CapabilityRow[] = [];
  const changed: CapabilityChange[] = [];
  for (const [kind, row] of next) {
    const old = previous.get(kind);
    if (!old) added.push(row);
    else if (JSON.stringify(canonical(old)) !== JSON.stringify(canonical(row)))
      changed.push({ before: old, after: row });
  }
  const removed = [...previous]
    .filter(([kind]) => !next.has(kind))
    .map(([, row]) => row);
  return { added, removed, changed };
}

function canonical(row: CapabilityRow): CapabilityRow {
  if (row.kind === "network") {
    return { kind: "network", hosts: [...row.hosts].sort() };
  }
  if (row.kind === "background") {
    return {
      kind: "background",
      jobs: [...row.jobs].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  return row;
}

/** Nicer job names than the manifest id: `refresh-scores` reads "Refresh scores". */
export function jobName(id: string) {
  return contributionName(id);
}
