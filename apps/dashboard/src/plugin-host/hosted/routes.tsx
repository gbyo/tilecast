import type { RouteObject } from "react-router";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import type { DiscoveredStudioPlugin } from "../discovery";
import { hostedClient, hostedInstanceKey } from "./api";
import { HostedInstanceEditor } from "./HostedInstanceEditor";
import { HostedInstancesPage } from "./HostedInstancesPage";
import { HostedSettingsPage } from "./HostedSettingsPage";
import { HostedConnectionEditor } from "./connections/HostedConnectionEditor";
import { HostedConnectionsPage } from "./connections/HostedConnectionsPage";
import { connectionsClient, connectionKey } from "./connections/api";
import { HostedFeedRecordsPage } from "./feeds/HostedFeedRecordsPage";
import { HostedFeedsPage } from "./feeds/HostedFeedsPage";
import { HostedStatusPage } from "./status/HostedStatusPage";
import { hasStatusPage } from "./status/model";
import { hostedLandingPage } from "./landing";
import { HostedWebhooksPage } from "./webhooks/HostedWebhooksPage";
import { hasWebhooksPage } from "./webhooks/model";

/**
 * The edit page's breadcrumb names the instance. It shares the editor's query
 * key, so the editor and the breadcrumb read one cached instance.
 */
const instanceResource = (
  pluginId: string,
  manifest: PluginManifestV3,
  kind: PluginManifestV3["instances"][number],
) => ({
  queryKey: (id: string) => hostedInstanceKey(pluginId, kind.kind, id),
  load: (id: string) =>
    hostedClient(manifest.api!.basePaths[0]!, kind.path).get(id),
});

/** A breadcrumb in the shared plugins namespace, not the plugin's own. */
const crumb = (breadcrumb: string, key: string) => ({
  breadcrumb,
  breadcrumbKey: { ns: "plugins", key },
});

/**
 * The pages the host generates for a Plugin Manifest API 3 plugin: the list,
 * the create and edit pages of each instance kind, the settings page, the
 * connection, feed, and webhook pages, and the status page.
 * The first kind also answers `new` and `:id` directly below the plugin's
 * route, the addresses its pages had before the host generated them.
 */
export function hostedRouteObjects(
  plugin: DiscoveredStudioPlugin,
): RouteObject[] {
  const v3 = plugin.manifest;
  if (v3.apiVersion !== 3) return [];
  const props = { pluginId: plugin.id, manifest: v3 };
  const out: RouteObject[] = [];
  // A plugin that brings its own index page keeps it; the host adds no
  // landing page in front of it.
  const customIndex = (plugin.definition.routes ?? []).some(
    (route) => route.index,
  );
  const landing = customIndex ? null : hostedLandingPage(v3);
  if (landing && landing !== "instances") {
    const pages = {
      settings: HostedSettingsPage,
      connections: HostedConnectionsPage,
      feeds: HostedFeedsPage,
      webhooks: HostedWebhooksPage,
      status: HostedStatusPage,
    } as const;
    const Page = pages[landing];
    out.push({ index: true, element: <Page {...props} /> });
  }
  if (v3.instances.length > 0) {
    if (landing === "instances") {
      out.push({ index: true, element: <HostedInstancesPage {...props} /> });
    }
    for (const kind of v3.instances) {
      const kindProps = { ...props, kindPath: kind.path };
      out.push(
        {
          path: kind.path,
          element: <HostedInstancesPage {...kindProps} />,
          handle: crumb(kind.noun.plural, "hosted.breadcrumbs.list"),
        },
        {
          path: `${kind.path}/new`,
          element: <HostedInstanceEditor {...kindProps} />,
          handle: crumb(`New ${kind.noun.singular}`, "hosted.breadcrumbs.new"),
        },
        {
          path: `${kind.path}/:id`,
          element: <HostedInstanceEditor {...kindProps} />,
          handle: {
            ...crumb(kind.noun.singular, "hosted.breadcrumbs.edit"),
            resource: instanceResource(plugin.id, v3, kind),
          },
        },
      );
    }
    const first = v3.instances[0]!;
    out.push(
      {
        path: "new",
        element: <HostedInstanceEditor {...props} />,
        handle: crumb(`New ${first.noun.singular}`, "hosted.breadcrumbs.new"),
      },
      {
        path: ":id",
        element: <HostedInstanceEditor {...props} />,
        handle: {
          ...crumb(first.noun.singular, "hosted.breadcrumbs.edit"),
          resource: instanceResource(plugin.id, v3, first),
        },
      },
    );
  }
  if ((v3.connections ?? []).length > 0) {
    out.push(
      {
        path: "connections",
        element: <HostedConnectionsPage {...props} />,
        handle: crumb("Connections", "hosted.breadcrumbs.connections"),
      },
      {
        path: "connections/new",
        element: <HostedConnectionEditor {...props} />,
        handle: crumb("New connection", "hosted.breadcrumbs.newConnection"),
      },
      {
        path: "connections/:connectionId",
        element: <HostedConnectionEditor {...props} />,
        handle: {
          ...crumb("Connection", "hosted.breadcrumbs.connection"),
          resource: {
            queryKey: (id: string) => connectionKey(plugin.id, id),
            load: (id: string) => connectionsClient(plugin.id).get(id),
          },
        },
      },
    );
  }
  if ((v3.feeds ?? []).length > 0) {
    out.push(
      {
        path: "feeds",
        element: <HostedFeedsPage {...props} />,
        handle: crumb("Feeds", "hosted.breadcrumbs.feeds"),
      },
      {
        path: "feeds/:datasetId",
        element: <HostedFeedRecordsPage {...props} />,
        handle: crumb("Records", "hosted.breadcrumbs.feedRecords"),
      },
    );
  }
  if (hasWebhooksPage(v3)) {
    out.push({
      path: "webhooks",
      element: <HostedWebhooksPage {...props} />,
      handle: crumb("Webhooks", "hosted.breadcrumbs.webhooks"),
    });
  }
  if (hasStatusPage(v3)) {
    out.push({
      path: "status",
      element: <HostedStatusPage {...props} />,
      handle: crumb("Status", "hosted.breadcrumbs.status"),
    });
  }
  if (v3.settings?.organization?.length) {
    out.push({
      path: "settings",
      element: <HostedSettingsPage {...props} />,
      handle: crumb("Settings", "hosted.breadcrumbs.settings"),
    });
  }
  return out;
}
