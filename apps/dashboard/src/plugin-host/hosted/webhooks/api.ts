import type { components } from "@tilecast/api-schema/generated/openapi";
import { request } from "../../../api/client";

export type PluginWebhookState = components["schemas"]["PluginWebhookState"];
export type PluginWebhookToken = components["schemas"]["PluginWebhookToken"];
export type CreatedWebhookToken = PluginWebhookToken & { token: string };

/**
 * The Studio client for a plugin's inbound webhooks: core routes below
 * `/plugins/{pluginId}/webhooks`, not routes of the plugin.
 */
export function webhooksClient(pluginId: string) {
  const base = `/plugins/${pluginId}/webhooks`;
  return {
    list: () => request<PluginWebhookState[]>(base),
    createToken: (webhookId: string, name: string, token: string) =>
      request<CreatedWebhookToken>(`${base}/${webhookId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({ name }),
      }),
    revokeToken: (webhookId: string, tokenId: string, token: string) =>
      request<PluginWebhookToken>(`${base}/${webhookId}/tokens/${tokenId}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": token },
      }),
  };
}

export const webhooksKey = (pluginId: string) =>
  ["plugin-webhooks", pluginId] as const;
