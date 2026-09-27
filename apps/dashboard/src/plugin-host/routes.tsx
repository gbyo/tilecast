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
      if (standalone.topLevel !== options.topLevel) continue;
      const children = qualifyBreadcrumbs(standalone.children, plugin.id);
      // Ownership marker for the composed-tree collision check: a plugin
      // must never shadow a core Studio route, wherever it mounts.
      const handle = { pluginStandaloneRoute: plugin.id };
      if (standalone.gate === "install") {
        out.push({
          path: standalone.path,
          handle,
          element: (
            <PluginRouteGate pluginId={plugin.id}>
              <Outlet />
            </PluginRouteGate>
          ),
          children,
        });
      } else {
        out.push({ path: standalone.path, handle, children });
      }
    }
  }
  return out;
}

/**
 * Absolute shape of a route path for collision checks. Parameter segments
 * (`:id`, `:code`) normalize together: two routes with the same shape answer
 * the same addresses, while `/screens/bulk` and `/screens/:id` coexist by
 * React Router ranking, exactly as core relies on today.
 */
function routeShape(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? ":param" : segment.toLowerCase(),
    )
    .join("/");
}

interface RouteClaim {
  shape: string;
  plugin?: string;
}

function collectRouteClaims(
  routes: RouteObject[],
  base: string,
  owner: string | undefined,
  out: RouteClaim[],
): void {
  for (const route of routes) {
    let absolute = base;
    if (typeof route.path === "string") {
      absolute = route.path.startsWith("/")
        ? route.path
        : `${base}/${route.path}`.replace(/\/+/g, "/");
    } else if (route.index) {
      absolute = base || "/";
    }
    const handle = route.handle as
      | { pluginStandaloneRoute?: unknown; pluginManagementRoute?: unknown }
      | undefined;
    // Ownership flows down the subtree: every address below a plugin's
    // standalone path or management route belongs to that plugin for
    // collision purposes.
    const standalone =
      typeof handle?.pluginStandaloneRoute === "string"
        ? handle.pluginStandaloneRoute
        : undefined;
    const managed =
      typeof handle?.pluginManagementRoute === "string"
        ? handle.pluginManagementRoute
        : undefined;
    const plugin = standalone ?? managed ?? owner;
    if (route.path !== undefined || route.index) {
      out.push({ shape: routeShape(absolute), plugin });
    }
    if (route.children) {
      collectRouteClaims(route.children, absolute || "/", plugin, out);
    }
  }
}

/**
 * Rejects a composed Studio route tree where a plugin shadows a core route
 * (or two plugins shadow each other at the same address). Core-core
 * duplicates are left to React Router: they predate plugins and rank by
 * declaration order. A plugin claim colliding with anything fails loudly
 * instead of silently overriding Studio.
 */
export function assertStudioRouteCollisions(routes: RouteObject[]): void {
  const claims: RouteClaim[] = [];
  collectRouteClaims(routes, "", undefined, claims);
  const byShape = new Map<string, RouteClaim[]>();
  for (const claim of claims) {
    const group = byShape.get(claim.shape) ?? [];
    group.push(claim);
    byShape.set(claim.shape, group);
  }
  for (const [shape, group] of byShape) {
    // A parent route and its own index child share one address by design, so
    // only distinct owners collide: a plugin shadowing core (or another
    // plugin) fails instead of silently overriding Studio.
    const owners = new Set(group.map((claim) => claim.plugin ?? "core"));
    if (owners.size > 1 && [...owners].some((owner) => owner !== "core")) {
      throw new Error(
        `Studio route ${JSON.stringify(shape)} is claimed by ${[...owners].join(" and ")}; a plugin must not shadow it`,
      );
    }
  }
}

/**
 * Route objects for every plugin that contributes routes, as children of the
 * `/plugins` route. The gate wraps the whole subtree once. Management route
 * ownership is structural: a plugin renders exactly below
 * `/plugins/<directory>`, never beside core routes.
 */
export function pluginRouteObjects(plugins = studioPlugins()): RouteObject[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.definition.routes && plugin.definition.routes.length > 0,
    )
    .map((plugin) => {
      const expected = `/plugins/${plugin.dir}`;
      if (plugin.route !== expected) {
        throw new Error(
          `plugins/${plugin.id} management route ${JSON.stringify(plugin.route)} must be ${JSON.stringify(expected)}`,
        );
      }
      return {
        path: plugin.route.replace(/^\/plugins\//, ""),
        handle: { breadcrumb: plugin.name, pluginManagementRoute: plugin.id },
        element: (
          <PluginRouteGate pluginId={plugin.id}>
            <Outlet />
          </PluginRouteGate>
        ),
        children: qualifyBreadcrumbs(plugin.definition.routes!, plugin.id),
      };
    });
}
