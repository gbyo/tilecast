import { Outlet, type RouteObject } from "react-router";
import { PluginRouteGate } from "../plugins/PluginRouteGate";
import { studioPlugins } from "./discovery";
import { pluginNamespace } from "./translation";

/**
 * A plugin names a breadcrumb translation by a key in its own namespace. The
 * host qualifies it, so the topbar resolves it with t() like any other label.
 */
function qualifyBreadcrumbs(
  routes: RouteObject[],
  pluginId: string,
): RouteObject[] {
  return routes.map((route) => {
    const original: unknown = route.handle;
    const handle = original as { breadcrumbKey?: unknown } | undefined;
    const children = route.children
      ? qualifyBreadcrumbs(route.children, pluginId)
      : undefined;
    const qualified =
      typeof handle?.breadcrumbKey === "string"
        ? {
            ...handle,
            breadcrumbKey: {
              ns: pluginNamespace(pluginId),
              key: handle.breadcrumbKey,
            },
          }
        : original;
    return {
      ...route,
      handle: qualified,
      ...(children ? { children } : {}),
    } as RouteObject;
  });
}

/**
 * Route objects for every plugin that contributes routes, as children of the
 * `/plugins` route. The gate wraps the whole subtree once.
 */
export function pluginRouteObjects(plugins = studioPlugins()): RouteObject[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.definition.routes && plugin.definition.routes.length > 0,
    )
    .map((plugin) => ({
      path: plugin.route.replace(/^\/plugins\//, ""),
      handle: { breadcrumb: plugin.name },
      element: (
        <PluginRouteGate pluginId={plugin.id}>
          <Outlet />
        </PluginRouteGate>
      ),
      children: qualifyBreadcrumbs(plugin.definition.routes!, plugin.id),
    }));
}
