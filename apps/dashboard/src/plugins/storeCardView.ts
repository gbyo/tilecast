import type { PluginStoreEntry, PluginStoreSource } from "../api/types";
import type { PluginsT } from "./pluginCatalog";

/**
 * The presentation of one plugin-store entry, normalized across the
 * included, marketplace, and custom sources so one card renders them all.
 * Source-specific knowledge stops here: the card never inspects which
 * source an entry came from.
 */
export type StoreCardView = {
  packageId: string;
  to: string;
  name: string;
  description: string;
  /** Present for external sources; included plugins have no publisher line. */
  publisher?: string;
  source: PluginStoreSource;
  /** Present for included plugins, whose icon Studio ships. */
  pluginId?: string;
  /** Tilecast-owned path to marketplace artwork, when the listing has any. */
  iconUrl?: string;
  /** Category identifiers, in display order. */
  categories: string[];
  installed: boolean;
  updateAvailable: boolean;
  compatible: boolean;
  featured: boolean;
};

/** Entries without any detail block carry nothing to show. */
export function storeCardView(entry: PluginStoreEntry): StoreCardView | null {
  const { plugin, marketplace, custom } = entry;
  const external = marketplace ?? custom;
  if (!plugin && !external) return null;

  return {
    packageId: entry.packageId,
    to: `/plugins/store/${encodeURIComponent(entry.packageId)}`,
    name: plugin?.name ?? external?.name ?? entry.packageId,
    description: plugin?.description ?? external?.description ?? "",
    publisher: plugin ? undefined : external?.publisherName,
    source: entry.source,
    pluginId: plugin?.id,
    iconUrl: plugin ? undefined : marketplace?.artwork?.iconUrl,
    categories: plugin ? [plugin.category] : (marketplace?.categories ?? []),
    installed: plugin?.installed ?? external?.installed ?? false,
    updateAvailable: marketplace?.updateAvailable ?? false,
    compatible: external?.compatible ?? true,
    featured: marketplace?.featured ?? false,
  };
}

/**
 * Labels a category. The four Studio categories are localized; a
 * marketplace slug outside them shows as written.
 */
export function storeCategoryLabel(category: string, t: PluginsT) {
  switch (category.toLocaleLowerCase()) {
    case "display":
      return t("catalog.categories.display");
    case "automation":
      return t("catalog.categories.automation");
    case "workflow":
      return t("catalog.categories.workflow");
    case "hardware":
      return t("catalog.categories.hardware");
    default:
      return category;
  }
}
