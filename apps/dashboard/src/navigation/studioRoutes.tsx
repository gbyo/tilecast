import { createContext, useContext, type ReactNode } from "react";
import { matchRoutes, type RouteObject } from "react-router";
import type { Capability, CapabilityRequirement } from "../auth/capabilities";
import type { StudioNavigationMetadata } from "./studioNavigation";

export type BreadcrumbResource =
  | "screen"
  | "screen-group"
  | "widget"
  | "data-source"
  | "playlist"
  | "layout"
  | "campaign"
  | "schedule";

/**
 * A breadcrumb resource a plugin contributes: how to name the `:id` in its
 * route. The query key is shared with the plugin's detail page, so `load`
 * must return the same full entity that page caches.
 */
export type BreadcrumbResourceLoader = {
  queryKey: (id: string) => readonly unknown[];
  load: (id: string) => Promise<{ name?: unknown } | null | undefined>;
};

export type StudioRouteHandle = {
  /**
   * Present on a route that is a navigation destination. The browser sidebar
   * and native hosts render the destination from this metadata; the route's
   * own path is where it leads. See studioNavigation.tsx.
   */
  navigation?: StudioNavigationMetadata;
  /** The English breadcrumb, and the fallback for breadcrumbKey. */
  breadcrumb?: string;
  /**
   * The breadcrumb's translation, resolved with t() at render so it follows
   * language changes. A plugin route gives a key in its own namespace as a
   * string; the plugin host qualifies it (see plugin-host/routes.tsx).
   */
  breadcrumbKey?: { ns: string; key: string };
  resource?: BreadcrumbResource | BreadcrumbResourceLoader;
  /**
   * A full-bleed editor workspace: no page padding, the compact editor
   * header that hosts the page's controls, and no page heading of its own.
   */
  immersiveEditor?: boolean;
  /**
   * A task-focused authoring route. Editor workspaces temporarily collapse
   * global navigation when horizontal space is constrained, even when the
   * page itself keeps ordinary padding (for example Playlist editing).
   */
  editorWorkspace?: boolean;
  /**
   * A route with substantial local navigation that should not permanently
   * compete with the global sidebar. The global navigation remains available
   * from the standard trigger as temporary navigation.
   */
  focusedWorkspace?: boolean;
  /**
   * The route needs at least one of these capabilities. Requirements stack
   * down the tree: a child route also needs everything its ancestors need.
   * The sidebar, native navigation catalog, command search, and the route
   * guard all read this one declaration, so they cannot disagree. Hiding a
   * route is a convenience; the API decides every request on its own.
   */
  capabilities?: readonly Capability[];
  search?: {
    label: string;
    description: string;
    /** Translation key resolved with t() at render; description is English. */
    descriptionKey?:
      | "palette.settingsSearch.dependencyGraph"
      | "palette.settingsSearch.sectionFallback";
    /** Interpolation values for descriptionKey, resolved at render. */
    descriptionValues?: { label: string };
    to: string;
    keywords?: string[];
  };
};

const StudioRoutesContext = createContext<readonly RouteObject[]>([]);

export function StudioRoutesProvider({
  routes,
  children,
}: {
  routes: readonly RouteObject[];
  children: ReactNode;
}) {
  return (
    <StudioRoutesContext.Provider value={routes}>
      {children}
    </StudioRoutesContext.Provider>
  );
}

export function useStudioRoutes() {
  return useContext(StudioRoutesContext);
}

export function studioRouteHandle(route: RouteObject): StudioRouteHandle {
  return (route.handle ?? {}) as StudioRouteHandle;
}

/** Whether the deepest route matching a path is an immersive editor. */
export function isImmersiveEditorRoute(
  routes: readonly RouteObject[],
  pathname: string,
): boolean {
  const matches = matchRoutes([...routes], pathname) ?? [];
  const deepest = matches.at(-1);
  return deepest
    ? studioRouteHandle(deepest.route).immersiveEditor === true
    : false;
}

/** Whether the deepest route is a task-focused authoring workspace. */
export function isEditorWorkspaceRoute(
  routes: readonly RouteObject[],
  pathname: string,
): boolean {
  const matches = matchRoutes([...routes], pathname) ?? [];
  const deepest = matches.at(-1);
  if (!deepest) return false;
  const handle = studioRouteHandle(deepest.route);
  return handle.editorWorkspace === true || handle.immersiveEditor === true;
}

/** Whether any matched route requests focused local navigation. */
export function isFocusedWorkspaceRoute(
  routes: readonly RouteObject[],
  pathname: string,
): boolean {
  const matches = matchRoutes([...routes], pathname) ?? [];
  return matches.some(
    (match) => studioRouteHandle(match.route).focusedWorkspace === true,
  );
}

/**
 * The requirement for a path: one capability group per matched route that
 * declares one, from the root down.
 */
export function routeRequirement(
  routes: readonly RouteObject[],
  pathname: string,
): CapabilityRequirement {
  const matches = matchRoutes(routes as RouteObject[], pathname) ?? [];
  return matches
    .map((match) => studioRouteHandle(match.route).capabilities)
    .filter((group): group is readonly Capability[] => Boolean(group));
}
