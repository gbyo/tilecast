import type { RouteObject } from "react-router";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import type { DiscoveredStudioPlugin } from "../discovery";
import { HostedInstanceEditor } from "./HostedInstanceEditor";
import { HostedInstancesPage } from "./HostedInstancesPage";
import { HostedSettingsPage } from "./HostedSettingsPage";

/** A breadcrumb in the shared plugins namespace, not the plugin's own. */
const crumb = (breadcrumb: string, key: string) => ({
  breadcrumb,
  breadcrumbKey: { ns: "plugins", key },
});

/**
 * The pages the host generates for a Plugin Manifest API 3 plugin: the list,
 * the create and edit pages of each instance kind, and the settings page.
 * The first kind also answers `new` and `:id` directly below the plugin's
 * route, the addresses its pages had before the host generated them.
 */
export function hostedRouteObjects(plugin: DiscoveredStudioPlugin): RouteObject[] {
  const manifest = plugin.manifest;
  if (manifest.apiVersion !== 3) return [];
  const v3 = manifest as unknown as PluginManifestV3;
  const props = { pluginId: plugin.id, manifest: v3 };
  const out: RouteObject[] = [];
  if (v3.instances.length > 0) {
    out.push({ index: true, element: <HostedInstancesPage {...props} /> });
    for (const kind of v3.instances) {
      out.push(
        { path: kind.path, element: <HostedInstancesPage {...props} />, handle: crumb(kind.noun.plural, "hosted.breadcrumbs.list") },
        { path: `${kind.path}/new`, element: <HostedInstanceEditor {...props} />, handle: crumb(`New ${kind.noun.singular}`, "hosted.breadcrumbs.new") },
        { path: `${kind.path}/:id`, element: <HostedInstanceEditor {...props} />, handle: crumb(kind.noun.singular, "hosted.breadcrumbs.edit") },
      );
    }
    const first = v3.instances[0]!;
    out.push(
      { path: "new", element: <HostedInstanceEditor {...props} />, handle: crumb(`New ${first.noun.singular}`, "hosted.breadcrumbs.new") },
      { path: ":id", element: <HostedInstanceEditor {...props} />, handle: crumb(first.noun.singular, "hosted.breadcrumbs.edit") },
    );
  } else if (v3.settings?.organization?.length) {
    out.push({ index: true, element: <HostedSettingsPage {...props} /> });
  }
  if (v3.settings?.organization?.length && v3.instances.length > 0) {
    out.push({ path: "settings", element: <HostedSettingsPage {...props} />, handle: crumb("Settings", "hosted.breadcrumbs.settings") });
  }
  return out;
}
