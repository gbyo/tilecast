import type { components } from "@tilecast/api-schema/generated/openapi";
import { request } from "../../../api/client";

export type PluginFeedDataset = components["schemas"]["PluginFeedDataset"];
export type PluginFeedField = components["schemas"]["PluginFeedField"];
export type PluginFeedRecord = components["schemas"]["PluginFeedRecord"];
export type PluginFeedRecords = components["schemas"]["PluginFeedRecords"];

/**
 * The Studio client for a plugin's feed datasets: core routes below
 * `/plugins/{pluginId}`, not routes of the plugin.
 */
export function feedsClient(pluginId: string) {
  const base = `/plugins/${pluginId}/feeds`;
  return {
    list: () => request<{ items: PluginFeedDataset[]; total: number }>(base),
    records: (datasetId: string, offset = 0, limit = 100) =>
      request<PluginFeedRecords>(
        `${base}/${datasetId}/records?offset=${offset}&limit=${limit}`,
      ),
    override: (
      datasetId: string,
      body: { recordId: string; field: string; value: unknown },
      token: string,
    ) =>
      request<PluginFeedRecord>(`${base}/${datasetId}/overrides`, {
        method: "PUT",
        headers: { "X-CSRF-Token": token },
        body: JSON.stringify(body),
      }),
  };
}

export const feedsKey = (pluginId: string) =>
  ["plugin-feeds", pluginId] as const;
export const feedRecordsKey = (pluginId: string, datasetId: string) =>
  ["plugin-feed-records", pluginId, datasetId] as const;
