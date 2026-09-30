import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { DiscoveredStudioPlugin } from "./discovery";
import type { StudioPluginSecondaryNavItem } from "./kit";

export interface ContributedSecondaryNavItem {
  pluginId: string;
  item: StudioPluginSecondaryNavItem;
}

/**
 * Every plugin's secondary-navigation contributions in deterministic order
 * (plugin id, then item id). Validation fails loudly: duplicate item ids,
 * paths outside the plugin's declared Studio route ownership, and collisions
 * with core routes never render as a broken sidebar.
 */
export function collectSecondaryNavItems(
  plugins: DiscoveredStudioPlugin[],
  corePaths: readonly string[] = [],
): ContributedSecondaryNavItem[] {
  const seen = new Map<string, string>();
  const out: ContributedSecondaryNavItem[] = [];
  const ordered = [...plugins].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const plugin of ordered) {
    const items = [...(plugin.definition.secondaryNavigation ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    for (const item of items) {
      if (item.id.trim() === "") {
        throw new Error(
          `plugins/${plugin.id} contributes a secondary-navigation item without an id`,
        );
      }
      // The id becomes part of an opaque native navigation destination id.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
        throw new Error(
          `plugins/${plugin.id} secondary-navigation item ${JSON.stringify(item.id)} must use lowercase letters, digits, and hyphens`,
        );
      }
      if (
        item.iconToken !== undefined &&
        !/^[a-z][a-z0-9-]*$/.test(item.iconToken)
      ) {
        throw new Error(
          `plugins/${plugin.id} secondary-navigation item ${JSON.stringify(item.id)} has an invalid iconToken ${JSON.stringify(item.iconToken)}`,
        );
      }
      const owner = seen.get(item.id);
      if (owner !== undefined) {
        throw new Error(
          `secondary-navigation item ${JSON.stringify(item.id)} is contributed by both plugins/${owner} and plugins/${plugin.id}`,
        );
      }
      seen.set(item.id, plugin.id);
      if (!isOwnedStudioPath(item.to, plugin)) {
        throw new Error(
          `plugins/${plugin.id} secondary-navigation item ${JSON.stringify(item.id)} points at ${JSON.stringify(item.to)}, outside its declared studio routes`,
        );
      }
      if (corePaths.includes(item.to)) {
        throw new Error(
          `plugins/${plugin.id} secondary-navigation item ${JSON.stringify(item.id)} collides with the core Studio route ${JSON.stringify(item.to)}`,
        );
      }
      out.push({ pluginId: plugin.id, item });
    }
  }
  return out;
}

function isOwnedStudioPath(
  to: string,
  plugin: { route: string; additionalRoutes: string[] },
): boolean {
  if (!to.startsWith("/") || to.includes("//")) return false;
  const owned = [plugin.route, ...plugin.additionalRoutes];
  return owned.some((base) => to === base || to.startsWith(`${base}/`));
}

function isVisible(
  item: StudioPluginSecondaryNavItem,
  query: { isError: boolean; isLoading: boolean; data: unknown },
): boolean {
  const visibility = item.visibility;
  if (visibility === undefined) return true;
  if (query.isError || query.isLoading) return false;
  try {
    return Boolean(visibility.visible(query.data));
  } catch {
    return false;
  }
}

/**
 * The contributions visible to the current viewer. Each item's visibility
 * query runs once, under a plugin-namespaced key, and every consumer (the
 * browser sidebar and the native navigation catalog) reads this one result.
 * Loading, errors, and predicate exceptions hide an item, and one plugin's
 * slow query never blocks another plugin's item.
 */
export function usePluginSecondaryNavigation(
  items: ContributedSecondaryNavItem[],
): ContributedSecondaryNavItem[] {
  const results = useQueries({
    queries: items.map(({ pluginId, item }) => ({
      queryKey: [
        "plugin-secondary-nav",
        pluginId,
        item.id,
        ...(item.visibility?.queryKey ?? []),
      ],
      queryFn: item.visibility?.queryFn ?? (() => Promise.resolve(null)),
      enabled: item.visibility !== undefined,
      retry: false,
      staleTime: 30_000,
    })),
  });
  const shown = items.map((entry, index) =>
    isVisible(entry.item, results[index]!),
  );
  const key = shown.map((value) => (value ? "1" : "0")).join("");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes shown
  return useMemo(() => items.filter((_, index) => shown[index]), [items, key]);
}
