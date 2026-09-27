import { isValidElement } from "react";
import type { RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import { studioRoutes } from "../App";
import {
  discoverStudioPlugins,
  hasStudioRoute,
  studioPlugins,
} from "./discovery";
import type { DiscoveredStudioPlugin } from "./discovery";
import type { StudioPluginSecondaryNavItem } from "./kit";
import {
  assertStudioRouteCollisions,
  pluginRouteObjects,
  pluginStandaloneRouteObjects,
} from "./routes";
import { collectSecondaryNavItems } from "./secondaryNav";

const manifest = (id: string, route?: string, additionalRoutes?: string[]) => ({
  apiVersion: 1 as const,
  id,
  definitionVersion: 1,
  name: "Sample",
  description: "Sample.",
  category: "Display" as const,
  icon: "hash",
  maintainers: ["@gbyo"],
  instanceNoun: { singular: "item", plural: "items" },
  ...(route
    ? {
        studio: {
          route,
          entrypoint: "./studio/index.tsx" as const,
          additionalRoutes,
        },
      }
    : {}),
});

function discoverSample(
  id: string,
  route: string,
  additionalRoutes: string[] | undefined,
  standaloneRoutes: NonNullable<
    Parameters<typeof pluginStandaloneRouteObjects>[1] extends never
      ? never
      : import("./kit").StudioPluginDefinition["standaloneRoutes"]
  >,
) {
  return discoverStudioPlugins(
    {
      [`../../../../plugins/sample-${id}/tilecast.plugin.json`]: manifest(
        id,
        route,
        additionalRoutes,
      ),
    },
    {
      [`../../../../plugins/sample-${id}/studio/index.tsx`]: {
        default: { id, standaloneRoutes },
      },
    },
  );
}

describe("Studio plugin discovery", () => {
  it("finds every bundled plugin's Studio entry point at build time", () => {
    expect(studioPlugins().map((plugin) => plugin.id)).toEqual([
      "countdown_bar",
      "emergency_alerts",
      "forms",
    ]);
    expect(hasStudioRoute("/plugins/countdown-bar")).toBe(true);
    expect(hasStudioRoute("/plugins/some-future-plugin")).toBe(false);
    for (const plugin of studioPlugins()) {
      expect(plugin.definition.icon, plugin.id).toBeDefined();
    }
  });

  it("pairs manifests and entry points by directory and refuses a mismatch", () => {
    const found = discoverStudioPlugins(
      {
        "../../../../plugins/sample-tally/tilecast.plugin.json": manifest(
          "sample_tally",
          "/plugins/sample-tally",
        ),
      },
      {
        "../../../../plugins/sample-tally/studio/index.tsx": {
          default: {
            id: "sample_tally",
            routes: [{ index: true, element: <p>Sample</p> }],
          },
        },
      },
    );
    expect(found).toMatchObject([
      {
        id: "sample_tally",
        dir: "sample-tally",
        route: "/plugins/sample-tally",
      },
    ]);

    expect(() =>
      discoverStudioPlugins(
        {
          "../../../../plugins/sample-tally/tilecast.plugin.json": manifest(
            "sample_tally",
            "/plugins/sample-tally",
          ),
        },
        {
          "../../../../plugins/sample-tally/studio/index.tsx": {
            default: { id: "other_plugin" },
          },
        },
      ),
    ).toThrow(/must export defineStudioPlugin/);
    expect(() =>
      discoverStudioPlugins(
        {
          "../../../../plugins/sample-tally/tilecast.plugin.json":
            manifest("sample_tally"),
        },
        {
          "../../../../plugins/sample-tally/studio/index.tsx": {
            default: { id: "sample_tally" },
          },
        },
      ),
    ).toThrow(/declares no studio route/);
  });

  it("mounts a plugin's routes below /plugins behind the install gate", () => {
    const [route] = pluginRouteObjects(
      discoverStudioPlugins(
        {
          "../../../../plugins/sample-tally/tilecast.plugin.json": manifest(
            "sample_tally",
            "/plugins/sample-tally",
          ),
        },
        {
          "../../../../plugins/sample-tally/studio/index.tsx": {
            default: {
              id: "sample_tally",
              routes: [
                { index: true, element: <p>Sample</p> },
                {
                  path: "new",
                  element: <p>New</p>,
                  handle: { breadcrumb: "New", breadcrumbKey: "crumbs.new" },
                },
              ],
            },
          },
        },
      ),
    );
    expect(route?.path).toBe("sample-tally");
    expect(route?.handle).toEqual({
      breadcrumb: "Sample",
      pluginManagementRoute: "sample_tally",
    });
    expect(isValidElement(route?.element)).toBe(true);
    expect(
      (route?.element as { props: { pluginId: string } }).props.pluginId,
    ).toBe("sample_tally");
    expect(route?.children).toHaveLength(2);
    // A plugin's breadcrumb key is qualified with its own namespace.
    expect(route?.children?.[1]?.handle).toEqual({
      breadcrumb: "New",
      breadcrumbKey: { ns: "plugin.sample_tally", key: "crumbs.new" },
    });
  });

  it("mounts standalone routes at their absolute paths with per-route gates", () => {
    const plugins = discoverSample(
      "sample_tally",
      "/plugins/sample-tally",
      ["/tally", "/tally-inbox"],
      [
        {
          path: "/tally",
          gate: "install",
          topLevel: true,
          children: [{ index: true, element: <p>Tally</p> }],
        },
        {
          path: "/tally-inbox",
          gate: "none",
          topLevel: false,
          children: [{ index: true, element: <p>Inbox</p> }],
        },
      ],
    );
    const top = pluginStandaloneRouteObjects({ topLevel: true }, plugins);
    expect(top.map((route) => route.path)).toEqual(["/tally"]);
    expect(isValidElement(top[0]?.element)).toBe(true);
    const app = pluginStandaloneRouteObjects({ topLevel: false }, plugins);
    expect(app.map((route) => route.path)).toEqual(["/tally-inbox"]);
    // No gate means no wrapper element.
    expect(app[0]?.element).toBeUndefined();
  });

  it("refuses standalone routes that collide or escape their declaration", () => {
    const declared = ["/tally"];
    const routes = [
      {
        path: "/tally",
        gate: "none" as const,
        topLevel: false as const,
        children: [{ index: true, element: <p>Tally</p> }],
      },
    ];
    // Two plugins claiming one path fail instead of silently overriding.
    expect(() =>
      pluginStandaloneRouteObjects({ topLevel: false }, [
        ...discoverSample("sample_a", "/plugins/sample-a", declared, routes),
        ...discoverSample("sample_b", "/plugins/sample-b", declared, routes),
      ]),
    ).toThrow(/both plugins/);
    // Below /plugins belongs to the management subtree, not standalone routes.
    expect(() =>
      pluginStandaloneRouteObjects(
        { topLevel: false },
        discoverSample(
          "sample_a",
          "/plugins/sample-a",
          ["/plugins/extra"],
          [
            {
              path: "/plugins/extra",
              gate: "none" as const,
              topLevel: false as const,
              children: [],
            },
          ],
        ),
      ),
    ).toThrow(/must not live below \/plugins/);
    // A route the manifest never declared never mounts.
    expect(() =>
      pluginStandaloneRouteObjects(
        { topLevel: false },
        discoverSample("sample_a", "/plugins/sample-a", undefined, routes),
      ),
    ).toThrow(/additionalRoutes/);
  });

  it("gives every plugin standalone route exactly one place in the Studio router", () => {
    const collect = (routes: RouteObject[], prefix: string, out: string[]) => {
      for (const route of routes) {
        const path = route.path ?? "";
        const full = path.startsWith("/")
          ? path
          : `${prefix}/${path}`.replace(/\/+/g, "/");
        // Only routes that declare their own path claim an address;
        // pathless layout routes share their parent's.
        if (path && full !== "/") out.push(full.replace(/\/$/, ""));
        collect(route.children ?? [], full || prefix, out);
      }
    };
    const paths: string[] = [];
    collect(studioRoutes, "", paths);
    const counts = new Map<string, number>();
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const plugin of studioPlugins()) {
      for (const standalone of plugin.definition.standaloneRoutes ?? []) {
        expect(
          counts.get(standalone.path),
          `${plugin.id} ${standalone.path}`,
        ).toBe(1);
      }
    }
  });

  it("refuses a plugin that shadows a core Studio route", () => {
    // The composed tree with every bundled plugin is collision-free: the
    // App module itself asserts this at startup, and the test proves the
    // assertion holds on the real tree.
    expect(() => assertStudioRouteCollisions(studioRoutes)).not.toThrow();
    // A standalone route over a core address fails instead of overriding it.
    const shadowing = discoverSample(
      "sample_shadow",
      "/plugins/sample-shadow",
      ["/activity"],
      [
        {
          path: "/activity",
          gate: "none" as const,
          topLevel: false as const,
          children: [{ index: true, element: <p>Shadow</p> }],
        },
      ],
    );
    const routes: RouteObject[] = [
      { path: "activity", element: <p>Core activity</p> },
      ...pluginStandaloneRouteObjects({ topLevel: false }, shadowing),
    ];
    expect(() => assertStudioRouteCollisions(routes)).toThrow(
      /claimed by core and sample_shadow/,
    );
  });

  it("keeps every plugin management route below its own directory", () => {
    for (const plugin of studioPlugins()) {
      if (!plugin.definition.routes?.length) continue;
      expect(plugin.route).toBe(`/plugins/${plugin.dir}`);
    }
    expect(() =>
      pluginRouteObjects(
        discoverStudioPlugins(
          {
            "../../../../plugins/sample-tally/tilecast.plugin.json": manifest(
              "sample_tally",
              "/plugins/somewhere-else",
            ),
          },
          {
            "../../../../plugins/sample-tally/studio/index.tsx": {
              default: {
                id: "sample_tally",
                routes: [{ index: true, element: <p>Sample</p> }],
              },
            },
          },
        ),
      ),
    ).toThrow(/management route/);
  });

  it("gives every discovered plugin route a place in the Studio router", () => {
    const plugins = studioRoutes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.path === "plugins");
    const paths = new Set(plugins?.children?.map((route) => route.path));
    for (const plugin of studioPlugins()) {
      expect(paths.has(plugin.route.replace("/plugins/", "")), plugin.id).toBe(
        true,
      );
    }
  });
});

describe("plugin secondary navigation", () => {
  const navItem = (
    id: string,
    to: string,
  ): StudioPluginSecondaryNavItem => ({
    id,
    to,
    icon: () => null,
    labelKey: `nav.${id}`,
  });

  const discovered = (
    id: string,
    dir: string,
    route: string,
    additionalRoutes: string[],
    secondaryNavigation: StudioPluginSecondaryNavItem[],
  ): DiscoveredStudioPlugin => ({
    id,
    dir,
    name: id,
    route,
    additionalRoutes,
    definition: { id, secondaryNavigation },
  });

  it("collects contributions in deterministic order", () => {
    const items = collectSecondaryNavItems(
      [
        discovered("forms", "forms", "/plugins/forms", ["/approvals"], [
          navItem("inbox", "/approvals/inbox"),
          navItem("approvals", "/approvals"),
        ]),
        discovered("alerts", "alerts", "/plugins/alerts", [], [
          navItem("review", "/plugins/alerts/review"),
        ]),
      ],
      ["/activity", "/settings"],
    );
    expect(items.map(({ pluginId, item }) => `${pluginId}/${item.id}`)).toEqual(
      ["alerts/review", "forms/approvals", "forms/inbox"],
    );
  });

  it("refuses duplicate item ids, unowned paths, and core collisions", () => {
    const forms = (secondaryNavigation: StudioPluginSecondaryNavItem[]) =>
      discovered("forms", "forms", "/plugins/forms", ["/approvals"], secondaryNavigation);
    // Two plugins contributing one item id fail instead of merging.
    expect(() =>
      collectSecondaryNavItems(
        [
          forms([navItem("approvals", "/approvals")]),
          discovered("other", "other", "/plugins/other", ["/other"], [
            navItem("approvals", "/other"),
          ]),
        ],
        [],
      ),
    ).toThrow(/both plugins\/forms and plugins\/other/);
    // A path outside the plugin's declared studio routes never renders.
    expect(() =>
      collectSecondaryNavItems([forms([navItem("sneaky", "/settings")])], []),
    ).toThrow(/outside its declared studio routes/);
    // A contributed item must not shadow a core secondary entry.
    expect(() =>
      collectSecondaryNavItems(
        [forms([navItem("settings", "/plugins/forms/settings")])],
        ["/plugins/forms/settings"],
      ),
    ).toThrow(/collides with the core Studio route/);
    // An empty id fails rather than rendering a duplicate key.
    expect(() =>
      collectSecondaryNavItems([forms([navItem("", "/approvals")])], []),
    ).toThrow(/without an id/);
  });
});
