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
 * A standalone route every plugin contribution agrees on: validated before it
 * mounts, so a plugin can never silently override an existing Studio route.
 */
function checkStandaloneRoute(
  plugin: { id: string; route: string; additionalRoutes: string[] },
  standalone: { path: string },
  owners: Map<string, string>,
): void {
  const { path } = standalone;
  if (!path.startsWith("/") || path !== normalizeStandalonePath(path)) {
    throw new Error(
      `plugins/${plugin.id} standalone route ${JSON.stringify(path)} must be an absolute path without a trailing slash`,
    );
  }
  if (path.startsWith("/plugins/") || path === "/plugins") {
    throw new Error(
      `plugins/${plugin.id} standalone route ${JSON.stringify(path)} must not live below /plugins (use routes)`,
    );
  }
  if (!plugin.additionalRoutes.includes(path)) {
    throw new Error(
      `plugins/${plugin.id} standalone route ${JSON.stringify(path)} must be declared in the manifest's studio.additionalRoutes`,
    );
  }
  if (path === plugin.route) {
    throw new Error(
      `plugins/${plugin.id} standalone route ${JSON.stringify(path)} duplicates its management route`,
    );
  }
  const owner = owners.get(path);
  if (owner !== undefined) {
    throw new Error(
      `standalone Studio route ${JSON.stringify(path)} is claimed by both plugins/${owner} and plugins/${plugin.id}`,
    );
  }
  owners.set(path, plugin.id);
}

function normalizeStandalonePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Route objects for every plugin standalone route, mounted at their absolute
 * paths. Pass `topLevel: true` for routes with their own shell outside the
 * operator sidebar, false for routes inside the authenticated Studio chrome.
 * The install gate applies per route, as each contribution declares.
 */
export function pluginStandaloneRouteObjects(
  options: { topLevel: boolean },
  plugins = studioPlugins(),
): RouteObject[] {
  const owners = new Map<string, string>();
  const out: RouteObject[] = [];
  for (const plugin of plugins) {
    for (const standalone of plugin.definition.standaloneRoutes ?? []) {
      checkStandaloneRoute(plugin, standalone, owners);
      if ((standalone.topLevel ?? false) !== options.topLevel) continue;
      const children = qualifyBreadcrumbs(standalone.children, plugin.id);
      if (standalone.gate === "install") {
        out.push({
          path: standalone.path,
          element: (
            <PluginRouteGate pluginId={plugin.id}>
              <Outlet />
            </PluginRouteGate>
          ),
          children,
        });
      } else {
        out.push({ path: standalone.path, children });
      }
    }
  }
  return out;
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
