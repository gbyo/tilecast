import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";

/** The Owner-reserved capability that retries and discards parked work. */
export const deliveriesCapability = "plugins.deliveries.manage";

/** Services whose work the host delivers through the delivery queue. */
const queuedServices = ["timers.schedule@1"];

/**
 * Whether the host generates a Status page for a plugin: it has queued
 * work the host runs for it.
 */
export function hasStatusPage(manifest: PluginManifestV3): boolean {
  return (manifest.services ?? []).some((service) =>
    queuedServices.includes(service),
  );
}

export const statusRoute = (manifest: PluginManifestV3) =>
  `${manifest.studio!.route}/status`;

/** Failure codes Studio explains. Any other code is shown as it is. */
export const knownFailures = [
  "handler_error",
  "handler_timeout",
  "handler_panic",
  "lease_expired",
] as const;

/** Delivery kinds Studio names. */
export const knownKinds = ["timer", "event", "webhook"] as const;

export function isKnown<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return (values as readonly string[]).includes(value);
}
