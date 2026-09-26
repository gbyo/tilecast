import { createContext, useContext, type ReactNode } from "react";
import type { RouteObject } from "react-router";

export type BreadcrumbResource =
  | "screen"
  | "screen-group"
  | "widget"
  | "data-source"
  | "playlist"
  | "layout"
  | "campaign"
  | "schedule"
  | "form"
  | "brand-bug"
  | "noise-meter";

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
  breadcrumb?: string;
  resource?: BreadcrumbResource | BreadcrumbResourceLoader;
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
