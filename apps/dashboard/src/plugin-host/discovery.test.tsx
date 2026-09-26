import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { studioRoutes } from "../App";
import {
  discoverStudioPlugins,
  hasStudioRoute,
  studioPlugins,
} from "./discovery";
import { pluginRouteObjects } from "./routes";

const manifest = (id: string, route?: string) => ({
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
    ? { studio: { route, entrypoint: "./studio/index.tsx" as const } }
    : {}),
});

describe("Studio plugin discovery", () => {
  it("finds every bundled plugin's Studio entry point at build time", () => {
    expect(studioPlugins().map((plugin) => plugin.id)).toEqual([
      "brand_bug",
      "countdown_bar",
      "emergency_alerts",
      "forms",
      "noise_meter",
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
    expect(route?.handle).toEqual({ breadcrumb: "Sample" });
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
