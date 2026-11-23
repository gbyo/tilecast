import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { hasStatusPage } from "./status/model";
import { hasWebhooksPage } from "./webhooks/model";

/** A page the host generates that a plugin's route can land on. */
export type HostedLandingPage =
  "instances" | "settings" | "connections" | "feeds" | "webhooks" | "status";

/**
 * The first meaningful generated page of a plugin, in a fixed order: its
 * instances, then organization settings, connections, feeds, webhooks, and
 * status. A plugin without instances lands on the first page it has, so it
 * never needs an artificial instance to have a landing page. Null when the
 * host generates no page.
 */
export function hostedLandingPage(
  manifest: PluginManifestV3,
): HostedLandingPage | null {
  if (manifest.instances.length > 0) return "instances";
  if ((manifest.settings?.organization?.length ?? 0) > 0) return "settings";
  if ((manifest.connections ?? []).length > 0) return "connections";
  if ((manifest.feeds ?? []).length > 0) return "feeds";
  if (hasWebhooksPage(manifest)) return "webhooks";
  if (hasStatusPage(manifest)) return "status";
  return null;
}
