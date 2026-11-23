import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";

/** The Owner-reserved capability that retries and discards parked work. */
export const deliveriesCapability = "plugins.deliveries.manage";

/** Services whose work or state the host reports on the Status page. */
const statusServices = ["timers.schedule@1", "events.publish@1"];

/**
 * Whether the host generates a Status page for a plugin: it has work the
 * host runs for it (timers, received events) or host-owned state an
 * operator reads (event subscriptions, published events and their schema,
 * inbound webhooks).
 */
export function hasStatusPage(manifest: PluginManifestV3): boolean {
  const events = manifest.events;
  return (
    (manifest.services ?? []).some((service) =>
      statusServices.includes(service),
    ) ||
    (events?.publishes?.length ?? 0) > 0 ||
    (events?.subscribes?.length ?? 0) > 0 ||
    (manifest.webhooks?.length ?? 0) > 0
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
