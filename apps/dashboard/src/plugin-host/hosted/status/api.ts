import type { components } from "@tilecast/api-schema/generated/openapi";
import { request } from "../../../api/client";

export type PluginStatus = components["schemas"]["PluginStatus"];
export type PluginDeliveryStatus =
  components["schemas"]["PluginDeliveryStatus"];
export type PluginParkedDelivery =
  components["schemas"]["PluginParkedDelivery"];
export type PluginProviderStatus = PluginStatus["providers"];
export type PluginEventSubscription = PluginStatus["subscriptions"][number];
export type PluginPublishedEventStatus =
  PluginStatus["publishedEvents"][number];

/**
 * The Studio client for a plugin's operational status: core routes below
 * `/plugins/{pluginId}`, not routes of the plugin.
 */
export function statusClient(pluginId: string) {
  const base = `/plugins/${pluginId}`;
  return {
    get: () => request<PluginStatus>(`${base}/status`),
    retry: (deliveryId: string, token: string) =>
      request<PluginParkedDelivery>(`${base}/deliveries/${deliveryId}/retry`, {
        method: "POST",
        headers: { "X-CSRF-Token": token },
      }),
    discard: (deliveryId: string, token: string) =>
      request<PluginParkedDelivery>(`${base}/deliveries/${deliveryId}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": token },
      }),
  };
}

export const statusKey = (pluginId: string) =>
  ["plugin-status", pluginId] as const;
