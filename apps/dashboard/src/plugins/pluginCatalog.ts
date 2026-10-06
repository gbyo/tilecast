import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api, ApiError } from "../api/client";
import type {
  PluginInUseResource,
  PluginStoreEntry,
  PluginStoreMarketplace,
  PluginSummary,
} from "../api/types";
import { toast } from "../components/ui/toast";

export type PluginsT = TFunction<"plugins", undefined>;

export const pluginCategories = [
  "Display",
  "Automation",
  "Workflow",
  "Hardware",
] as const;

export type PluginStatusKey =
  | "status.attention"
  | "status.active"
  | "status.configured"
  | "status.needsSetup";

/**
 * The single status shown for an installed plugin. Attention notes are
 * advisory — a plugin may be installed before its Player exists — so a plugin
 * nobody has set up yet reads as needing setup, with the note alongside.
 * Returns a key into the plugins namespace; the caller translates at render.
 */
export function pluginStatusKey(plugin: PluginSummary): PluginStatusKey {
  if (!plugin.configured) return "status.needsSetup";
  if (plugin.attention.length > 0) return "status.attention";
  if (plugin.active) return "status.active";
  if (plugin.configured) return "status.configured";
  return "status.needsSetup";
}

export function instanceSummary(plugin: PluginSummary) {
  const noun =
    plugin.instanceCount === 1
      ? plugin.instanceNounSingular
      : plugin.instanceNounPlural;
  return `${plugin.instanceCount} ${noun}`;
}

/**
 * The requirements worth a line in the catalog list: where the plugin can run
 * at all. The detail step shows every requirement.
 */
export function headlineRequirements(plugin: PluginSummary) {
  return plugin.requirements.filter((requirement) =>
    ["platform", "hardware", "region"].includes(requirement.kind),
  );
}

/** True when this Studio bundle has a page for the server's route. */
export { hasStudioRoute } from "../plugin-host/discovery";

export const pluginsQueryKey = ["plugins"] as const;

export function usePluginCatalog() {
  return useQuery({ queryKey: pluginsQueryKey, queryFn: api.plugins });
}

export const pluginStoreQueryKey = ["plugin-store"] as const;

export function pluginStoreEntryQueryKey(packageId: string) {
  return [...pluginStoreQueryKey, packageId] as const;
}

export function usePluginStore() {
  return useQuery({ queryKey: pluginStoreQueryKey, queryFn: api.pluginStore });
}

export function usePluginStoreEntry(packageId: string) {
  return useQuery({
    queryKey: pluginStoreEntryQueryKey(packageId),
    queryFn: () => api.pluginStoreEntry(packageId),
  });
}

export function usePluginLifecycle(csrfToken: string) {
  const queryClient = useQueryClient();
  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: pluginsQueryKey }),
      queryClient.invalidateQueries({ queryKey: pluginStoreQueryKey }),
    ]);
  const install = useMutation({
    mutationFn: (id: string) => api.installPlugin(id, csrfToken),
    onSuccess: () => {
      toast.add({ title: "Plugin installed.", type: "success" });
      return settle();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removePlugin(id, csrfToken),
    onSuccess: () => {
      toast.add({ title: "Plugin removed.", type: "success" });
      return settle();
    },
  });
  return { install, remove };
}

export type StoreCategoryFilter = "All" | (typeof pluginCategories)[number];
/** "all" plus any source kind the server reports, including future ones. */
export type StoreSourceFilter = string;

/**
 * The Explore list: category and source narrow the list, while search matches
 * source-specific metadata. Marketplace listings do not have a plugin
 * category yet, so category filters intentionally show release-owned plugins.
 * Installed entries remain browseable for details, versions, and updates.
 */
export function filterStoreEntries(
  entries: PluginStoreEntry[],
  query: string,
  category: StoreCategoryFilter,
  source: StoreSourceFilter = "all",
) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (source !== "all" && entry.source.kind !== source) return false;

    const plugin = entry.plugin;
    const listing = entry.marketplace;
    if (!plugin && !listing) return false;
    if (category !== "All" && plugin?.category !== category) return false;
    if (!needle) return true;

    const haystack = plugin
      ? [
          plugin.name,
          plugin.description,
          plugin.category,
          ...plugin.capabilities,
        ]
      : marketplaceHaystack(listing as PluginStoreMarketplace);

    return haystack.join(" ").toLocaleLowerCase().includes(needle);
  });
}

function marketplaceHaystack(listing: PluginStoreMarketplace) {
  return [
    listing.name,
    listing.description ?? "",
    listing.publisherName,
    listing.publisherId,
  ];
}

/** Refresh the signed marketplace catalog and invalidate the store cache. */
export function useRefreshMarketplaceCatalog(csrfToken: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshMarketplaceCatalog(csrfToken),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginStoreQueryKey }),
  });
}

/** The plugin-owned resources a 409 plugin_in_use response says remain. */
export function inUseResources(error: unknown): PluginInUseResource[] | null {
  if (!(error instanceof ApiError) || error.code !== "plugin_in_use")
    return null;
  const resources = error.details?.resources;
  return Array.isArray(resources) ? (resources as PluginInUseResource[]) : [];
}
