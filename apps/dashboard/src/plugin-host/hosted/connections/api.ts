import type { components } from "@tilecast/api-schema/generated/openapi";
import { request } from "../../../api/client";

export type PluginConnection = components["schemas"]["PluginConnection"];
export type PluginConnectionReference =
  components["schemas"]["PluginConnectionReference"];

export interface ConnectionWrite {
  definition?: string;
  name: string;
  origin?: string;
  expectedRevision?: number;
}

export interface ConsentWrite {
  privateNetwork: boolean;
  plainHttp: boolean;
  plaintextSecret: boolean;
  expectedRevision: number;
}

/**
 * The Studio client for a plugin's host-owned connection records. These are
 * core routes below `/plugins/{pluginId}`, not routes of the plugin.
 */
export function connectionsClient(pluginId: string) {
  const base = `/plugins/${pluginId}/connections`;
  const csrf = (token: string) => ({ "X-CSRF-Token": token });
  return {
    list: () => request<{ items: PluginConnection[]; total: number }>(base),
    get: (id: string) => request<PluginConnection>(`${base}/${id}`),
    create: (body: ConnectionWrite, token: string) =>
      request<PluginConnection>(base, {
        method: "POST",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    update: (id: string, body: ConnectionWrite, token: string) =>
      request<PluginConnection>(`${base}/${id}`, {
        method: "PUT",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    consents: (id: string, body: ConsentWrite, token: string) =>
      request<PluginConnection>(`${base}/${id}/consents`, {
        method: "PUT",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    remove: (id: string, token: string) =>
      request<void>(`${base}/${id}`, {
        method: "DELETE",
        headers: csrf(token),
      }),
  };
}

export const connectionsKey = (pluginId: string) =>
  ["plugin-connections", pluginId] as const;
export const connectionKey = (pluginId: string, id: string) =>
  ["plugin-connection", pluginId, id] as const;
