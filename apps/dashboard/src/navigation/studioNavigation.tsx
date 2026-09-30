import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RouteObject } from "react-router";
import { useTranslation } from "react-i18next";
import type navigationMessages from "@/locales/en/navigation.json";
import type { PluginIconComponent } from "@/plugin-host/kit";
import { studioPlugins } from "@/plugin-host/discovery";
import {
  collectSecondaryNavItems,
  usePluginSecondaryNavigation,
} from "@/plugin-host/secondaryNav";
import { pluginNamespace } from "@/plugin-host/translation";
import { studioRouteHandle, useStudioRoutes } from "./studioRoutes";

type NavigationMessages = typeof navigationMessages;

export type NavigationLabelKey =
  "overview" | `items.${Extract<keyof NavigationMessages["items"], string>}`;

type NavigationGroupLabelKey =
  `groups.${Extract<keyof NavigationMessages["groups"], string>}`;

/** Where a compact-width native host prefers a destination. */
export type NavigationPlacement = "primary" | "more";

/**
 * Studio's semantic navigation groups, in display order. A group without a
 * label renders without a heading. Secondary groups sit at the bottom of the
 * browser sidebar.
 */
export const studioNavigationGroups = [
  { id: "home", placement: "main" },
  { id: "screens", placement: "main", labelKey: "groups.screens" },
  { id: "content", placement: "main", labelKey: "groups.content" },
  { id: "presentations", placement: "main", labelKey: "groups.presentations" },
  { id: "operations", placement: "main", labelKey: "groups.operations" },
  { id: "secondary", placement: "secondary" },
] as const satisfies readonly {
  id: string;
  placement: "main" | "secondary";
  labelKey?: NavigationGroupLabelKey;
}[];

export type StudioNavigationGroupId =
  (typeof studioNavigationGroups)[number]["id"];

/**
 * Semantic navigation metadata for a route that is a navigation destination.
 * It lives on the route's handle, so the destination's path is always the
 * route's own path. Nothing here is React- or platform-specific: the browser
 * sidebar and native hosts both render it.
 */
export type StudioNavigationMetadata = {
  /** Stable, opaque destination identifier. Native hosts never interpret it. */
  id: string;
  group: StudioNavigationGroupId;
  labelKey: NavigationLabelKey;
  /** Semantic icon token; see packages/native-bridge-schema/icon-tokens.json. */
  icon: string;
  /** Position inside the group; lower first. */
  order: number;
  /** Omitted means "more". */
  mobilePlacement?: NavigationPlacement;
  /** Web matching only: active on the exact path, not below it. */
  end?: boolean;
  /** Web matching only: paths below the route that belong to no destination. */
  excludeActiveOn?: readonly string[];
};

/** Plugin contributions sit between Activity and Settings. */
const pluginContributionOrder = 500;

export type NavigationDestinationDefinition = StudioNavigationMetadata & {
  /** The route's absolute path. */
  to: string;
};

export type ResolvedNavigationDestination = {
  id: string;
  title: string;
  icon: string;
  to: string;
  order: number;
  mobilePlacement: NavigationPlacement;
  end?: boolean;
  excludeActiveOn?: readonly string[];
  /** Browser only: a plugin's own icon component. */
  Icon?: PluginIconComponent;
};

export type ResolvedNavigationGroup = {
  id: string;
  /** Omitted for a group without a heading. */
  title?: string;
  placement: "main" | "secondary";
  items: ResolvedNavigationDestination[];
};

export type ResolvedStudioNavigation = {
  groups: ResolvedNavigationGroup[];
  destinations: ResolvedNavigationDestination[];
};

function joinPath(base: string, path: string) {
  if (path.startsWith("/")) return path;
  return `${base}/${path}`.replace(/\/+/g, "/");
}

/**
 * Every route in the tree that carries navigation metadata, with its path
 * derived from the tree. A destination must be a static path, and an id can
 * name only one route.
 */
export function collectNavigationDestinations(
  routes: readonly RouteObject[],
): NavigationDestinationDefinition[] {
  const destinations: NavigationDestinationDefinition[] = [];
  const seen = new Set<string>();
  const visit = (route: RouteObject, base: string) => {
    const absolute =
      typeof route.path === "string" ? joinPath(base, route.path) : base;
    const navigation = studioRouteHandle(route).navigation;
    if (navigation) {
      const to = absolute || "/";
      if (seen.has(navigation.id)) {
        throw new Error(
          `navigation destination ${JSON.stringify(navigation.id)} is declared twice`,
        );
      }
      if (/[:*]/.test(to)) {
        throw new Error(
          `navigation destination ${JSON.stringify(navigation.id)} must be a static path, not ${JSON.stringify(to)}`,
        );
      }
      seen.add(navigation.id);
      destinations.push({ ...navigation, to });
    }
    route.children?.forEach((child) => visit(child, absolute));
  };
  routes.forEach((route) => visit(route, ""));
  return destinations;
}

function matches(pathname: string, path: string) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * The destination the current location belongs to: the longest matching
 * destination path, honoring exact-only destinations and exclusions. Null
 * when the location belongs to no destination, such as My Account.
 */
export function resolveActiveDestination<
  Destination extends Pick<
    ResolvedNavigationDestination,
    "to" | "end" | "excludeActiveOn"
  >,
>(pathname: string, destinations: readonly Destination[]): Destination | null {
  let best: Destination | null = null;
  for (const destination of destinations) {
    if (destination.excludeActiveOn?.some((path) => matches(pathname, path))) {
      continue;
    }
    const active = destination.end
      ? pathname === destination.to
      : matches(pathname, destination.to);
    if (active && (!best || destination.to.length > best.to.length)) {
      best = destination;
    }
  }
  return best;
}

/** Plugin destination ids are namespaced so they cannot collide with core. */
export function pluginDestinationId(pluginId: string, itemId: string) {
  return `plugin:${pluginId}:${itemId}`;
}

/**
 * Resolves Studio navigation once: core route metadata, plugin secondary
 * navigation after each plugin's own visibility rules, and localized labels.
 * The browser sidebar and the native navigation catalog both consume this.
 */
function useResolvedStudioNavigation(): ResolvedStudioNavigation {
  const routes = useStudioRoutes();
  const { t } = useTranslation("navigation");
  const core = useMemo(() => collectNavigationDestinations(routes), [routes]);
  // A malformed contribution fails the shell loudly rather than rendering a
  // broken sidebar, so this runs outside any error boundary that would hide
  // it.
  const contributions = useMemo(
    () =>
      collectSecondaryNavItems(
        studioPlugins(),
        core.map((destination) => destination.to),
      ),
    [core],
  );
  const visible = usePluginSecondaryNavigation(contributions);

  return useMemo(() => {
    // Plugin labels live in plugin namespaces the typed resources do not list.
    const translateKey = t as unknown as (
      key: string,
      options: { ns: string; defaultValue: string },
    ) => string;
    const entries: { group: string; item: ResolvedNavigationDestination }[] = [
      ...core.map((destination) => ({
        group: destination.group,
        item: {
          id: destination.id,
          title: t(destination.labelKey),
          icon: destination.icon,
          to: destination.to,
          order: destination.order,
          mobilePlacement: destination.mobilePlacement ?? "more",
          end: destination.end,
          excludeActiveOn: destination.excludeActiveOn,
        },
      })),
      ...visible.map(({ pluginId, item }) => ({
        group: "secondary",
        item: {
          id: pluginDestinationId(pluginId, item.id),
          title: translateKey(item.labelKey, {
            ns: pluginNamespace(pluginId),
            defaultValue: item.id,
          }),
          icon: item.iconToken ?? "plugin",
          to: item.to,
          order: pluginContributionOrder,
          mobilePlacement: "more" as const,
          Icon: item.icon,
        },
      })),
    ];
    const groups = studioNavigationGroups
      .map((group): ResolvedNavigationGroup => {
        const labelKey = "labelKey" in group ? group.labelKey : undefined;
        return {
          id: group.id,
          ...(labelKey ? { title: t(labelKey) } : {}),
          placement: group.placement,
          // Array.prototype.sort is stable, so equal orders keep core first
          // and plugin contributions in their deterministic order.
          items: entries
            .filter((entry) => entry.group === group.id)
            .map((entry) => entry.item)
            .sort((left, right) => left.order - right.order),
        };
      })
      .filter((group) => group.items.length > 0);
    return { groups, destinations: groups.flatMap((group) => group.items) };
    // t changes identity with the language, which re-resolves the labels.
  }, [core, visible, t]);
}

const StudioNavigationContext = createContext<ResolvedStudioNavigation | null>(
  null,
);

export function StudioNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const navigation = useResolvedStudioNavigation();
  return (
    <StudioNavigationContext.Provider value={navigation}>
      {children}
    </StudioNavigationContext.Provider>
  );
}

/** The resolved navigation model. Requires StudioNavigationProvider. */
export function useStudioNavigation(): ResolvedStudioNavigation {
  const navigation = useContext(StudioNavigationContext);
  if (!navigation) {
    throw new Error(
      "useStudioNavigation must be used inside StudioNavigationProvider",
    );
  }
  return navigation;
}
