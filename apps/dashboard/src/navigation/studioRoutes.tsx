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
  | "countdown-bar"
  | "brand-bug"
  | "noise-meter";

export type StudioRouteHandle = {
  breadcrumb?: string;
  resource?: BreadcrumbResource;
  search?: {
    label: string;
    description: string;
    /** Translation key resolved with t() at render; description is English. */
    descriptionKey?: "palette.settingsSearch.dependencyGraph";
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
