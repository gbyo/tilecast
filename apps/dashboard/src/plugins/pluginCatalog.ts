import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { api, ApiError } from "../api/client";
import type {
  PluginInUseResource,
  PluginStoreCustom,
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
 * source-specific metadata. Marketplace and custom entries do not have a
 * plugin category yet, so category filters intentionally show release-owned
 * plugins. Installed entries remain browseable for details, versions, and
 * updates.
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
    const custom = entry.custom;
    if (!plugin && !listing && !custom) return false;
    if (category !== "All" && plugin?.category !== category) return false;
    if (!needle) return true;

    const haystack = plugin
      ? [
          plugin.name,
          plugin.description,
          plugin.category,
          ...plugin.capabilities,
        ]
      : listing != null
        ? marketplaceHaystack(listing)
        : customHaystack(custom as PluginStoreCustom);
    return haystack.join(" ").toLocaleLowerCase().includes(needle);
  });
}

function marketplaceHaystack(listing: PluginStoreMarketplace) {
  return [
    listing.name,
    listing.description ?? "",
    listing.publisherName,
    listing.publisherId,
    ...(listing.categories ?? []),
  ];
}

function customHaystack(custom: PluginStoreCustom) {
  return [
    custom.name,
    custom.description ?? "",
    custom.publisherName,
    custom.publisherId,
  ];
}

export const packagesQueryKey = ["packages"] as const;

export function packageQueryKey(packageId: string) {
  return [...packagesQueryKey, packageId] as const;
}

export function usePackages() {
  return useQuery({ queryKey: packagesQueryKey, queryFn: api.listPackages });
}

export function usePackage(packageId: string, enabled = true) {
  return useQuery({
    queryKey: packageQueryKey(packageId),
    queryFn: () => api.getPackage(packageId),
    enabled,
  });
}

/**
 * External package lifecycle: resolving a repository for review,
 * installing it, and managing the installation. Every success settles
 * both the packages and the store queries, since installation state
 * renders in both places.
 */
export function usePackageLifecycle(csrfToken: string) {
  const queryClient = useQueryClient();
  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: packagesQueryKey }),
      queryClient.invalidateQueries({ queryKey: pluginStoreQueryKey }),
    ]);
  const resolve = useMutation({
    mutationFn: (repository: string) =>
      api.resolveGitHubRepository(repository, csrfToken),
  });
  const resolveMarketplace = useMutation({
    mutationFn: (packageId: string) =>
      api.resolveMarketplacePackage(packageId, csrfToken),
  });
  const install = useMutation({
    mutationFn: ({
      packageId,
      repository,
    }: {
      packageId: string;
      repository?: string;
    }) => api.installStorePackage(packageId, csrfToken, repository),
    onSuccess: () => settle(),
  });
  const checkUpdate = useMutation({
    mutationFn: (packageId: string) =>
      api.checkPackageUpdate(packageId, csrfToken),
    onSuccess: () => settle(),
  });
  const applyUpdate = useMutation({
    mutationFn: ({
      packageId,
      digest,
    }: {
      packageId: string;
      digest: string;
    }) => api.applyPackageUpdate(packageId, digest, csrfToken),
    onSuccess: () => settle(),
  });
  const rollback = useMutation({
    mutationFn: (packageId: string) =>
      api.rollbackPackage(packageId, csrfToken),
    onSuccess: () => settle(),
  });
  const remove = useMutation({
    mutationFn: (packageId: string) => api.removePackage(packageId, csrfToken),
    onSuccess: () => settle(),
  });
  return {
    resolve,
    resolveMarketplace,
    install,
    checkUpdate,
    applyUpdate,
    rollback,
    remove,
  };
}

/** Refresh the official Tilecast marketplace and invalidate the store cache. */
export function useRefreshMarketplaceCatalog(csrfToken: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshMarketplaceCatalog(csrfToken),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginStoreQueryKey }),
  });
}

/**
 * The owned resources a 409 in-use response says remain. Plugins and
 * packages share the details shape; only the code differs.
 */
export function inUseResources(error: unknown): PluginInUseResource[] | null {
  if (
    !(error instanceof ApiError) ||
    (error.code !== "plugin_in_use" && error.code !== "package_in_use")
  )
    return null;
  const resources = error.details?.resources;
  return Array.isArray(resources) ? (resources as PluginInUseResource[]) : [];
}

/** One contribution an update adds or drops, by kind and package path. */
export type ContributionChange = { kind: string; path: string };

/**
 * What an update changes about contributions: the review's (type, path)
 * pairs against the installed (kind, path) rows. Paths normalize a
 * leading ./, since manifests and rows spell it differently.
 */
export function diffContributions(
  current: { kind: string; path: string }[],
  next: { type: string; path: string }[],
): { added: ContributionChange[]; removed: ContributionChange[] } {
  const key = (kind: string, path: string) =>
    `${kind} ${path.replace(/^\.\//, "")}`;
  const before = new Map(
    current.map((item) => [key(item.kind, item.path), item] as const),
  );
  const after = new Map(
    next.map((item) => [key(item.type, item.path), item] as const),
  );
  const added: ContributionChange[] = [];
  for (const [id, item] of after) {
    if (!before.has(id)) added.push({ kind: item.type, path: item.path });
  }
  const removed: ContributionChange[] = [];
  for (const [id, item] of before) {
    if (!after.has(id)) removed.push({ kind: item.kind, path: item.path });
  }
  return { added, removed };
}
