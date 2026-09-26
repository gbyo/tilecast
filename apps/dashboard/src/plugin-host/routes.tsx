import { Outlet, type RouteObject } from "react-router";
import { PluginRouteGate } from "../plugins/PluginRouteGate";
import { studioPlugins } from "./discovery";

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
      children: plugin.definition.routes,
    }));
}
