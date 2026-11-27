import type { components } from "@tilecast/api-schema/generated/openapi";
import { request } from "../../../api/client";

export type PluginConnection = components["schemas"]["PluginConnection"];
export type PluginConnectionReference =
  components["schemas"]["PluginConnectionReference"];

export type PluginConnectionOAuth =
  components["schemas"]["PluginConnectionOAuth"];

export interface ConnectionWrite {
  definition?: string;
  name: string;
  origin?: string;
  /** OAuth connections only. An empty string removes the client ID. */
  clientId?: string;
  /** Write-only. Studio never reads a client secret back. */
  clientSecret?: string;
  clearClientSecret?: boolean;
  expectedRevision?: number;
}

/** What the provider returned to the callback, as Studio hands it on. */
export interface OAuthCallback {
  state: string;
  code?: string;
  error?: string;
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
    startOAuth: (id: string, token: string) =>
      request<{ authorizationUrl: string }>(`${base}/${id}/oauth/start`, {
        method: "POST",
        headers: csrf(token),
      }),
    completeOAuth: (id: string, body: OAuthCallback, token: string) =>
      request<PluginConnection>(`${base}/${id}/oauth/complete`, {
        method: "POST",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    disconnectOAuth: (id: string, token: string) =>
      request<PluginConnection>(`${base}/${id}/oauth/disconnect`, {
        method: "POST",
        headers: csrf(token),
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
