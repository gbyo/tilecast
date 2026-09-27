import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { DiscoveredStudioPlugin } from "./discovery";
import type { StudioPluginSecondaryNavItem } from "./kit";
import { pluginNamespace } from "./translation";

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

function ContributedSecondaryNavRow({
  pluginId,
  item,
}: ContributedSecondaryNavItem) {
  const { t } = useTranslation();
  // Item labels live in plugin namespaces the typed resources do not list.
  const translateKey = t as unknown as (
    key: string,
    options: { ns: string; defaultValue: string },
  ) => string;
  const location = useLocation();
  const visibility = item.visibility;
  // One query per mounted item, always called in the same order: the item
  // list is deterministic, so hooks stay valid while visibility resolves.
  const query = useQuery({
    queryKey: [
      "plugin-secondary-nav",
      pluginId,
      item.id,
      ...(visibility?.queryKey ?? []),
    ],
    queryFn: visibility?.queryFn ?? (() => Promise.resolve(undefined)),
    enabled: visibility !== undefined,
    retry: false,
    staleTime: 30_000,
  });
  if (visibility !== undefined) {
    if (query.isError || query.isLoading) return null;
    let show: boolean;
    try {
      show = visibility.visible(query.data);
    } catch {
      return null;
    }
    if (!show) return null;
  }
  const title = translateKey(item.labelKey, {
    ns: pluginNamespace(pluginId),
    defaultValue: item.id,
  });
  const active =
    location.pathname === item.to ||
    location.pathname.startsWith(`${item.to}/`);
  const Icon = item.icon;
  return (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton
        tooltip={title}
        isActive={active}
        render={
          <Link to={item.to} aria-current={active ? "page" : undefined} />
        }
      >
        <Icon />
        <span>{title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The sidebar renders this between Activity and Settings. Each row manages
 * its own visibility query, so one plugin's slow inbox never blocks another
 * plugin's item — or the core entries around them.
 */
export function PluginSecondaryNavItems({
  items,
}: {
  items: ContributedSecondaryNavItem[];
}) {
  return (
    <>
      {items.map(({ pluginId, item }) => (
        <ContributedSecondaryNavRow
          key={`${pluginId}/${item.id}`}
          pluginId={pluginId}
          item={item}
        />
      ))}
    </>
  );
}
