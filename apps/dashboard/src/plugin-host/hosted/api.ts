import { request } from "../../api/client";
import type { HostedDocument, SecretState } from "./model";

/** The Studio client for a Plugin Manifest API 3 plugin's host-owned routes. */
export function hostedClient(basePath: string, kindPath: string) {
  const collection = `${basePath}/${kindPath}`;
  const csrf = (token: string) => ({ "X-CSRF-Token": token });
  return {
    list: () => request<{ items: HostedDocument[]; total: number }>(collection),
    get: (id: string) => request<HostedDocument>(`${collection}/${id}`),
    create: (body: Record<string, unknown>, token: string) =>
      request<HostedDocument>(collection, {
        method: "POST",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    update: (id: string, body: Record<string, unknown>, token: string) =>
      request<HostedDocument>(`${collection}/${id}`, {
        method: "PUT",
        headers: csrf(token),
        body: JSON.stringify(body),
      }),
    remove: (id: string, token: string) =>
      request<void>(`${collection}/${id}`, {
        method: "DELETE",
        headers: csrf(token),
      }),
  };
}

export interface HostedSettings {
  scope: "organization" | "screen";
  screenId?: string;
  values: Record<string, unknown>;
  secrets?: Record<string, SecretState>;
  revision: number;
}

export function settingsClient(basePath: string) {
  const path = `${basePath}/settings/organization`;
  return {
    get: () => request<HostedSettings>(path),
    put: (body: Record<string, unknown>, token: string) =>
      request<HostedSettings>(path, {
        method: "PUT",
        headers: { "X-CSRF-Token": token },
        body: JSON.stringify(body),
      }),
  };
}

export const hostedInstancesKey = (pluginId: string, kind: string) =>
  ["plugin-instances", pluginId, kind] as const;
export const hostedInstanceKey = (pluginId: string, kind: string, id: string) =>
  ["plugin-instance", pluginId, kind, id] as const;
export const hostedSettingsKey = (pluginId: string) =>
  ["plugin-settings", pluginId] as const;

/** The code the Server answers a stale expectedRevision with. */
export const REVISION_CONFLICT_CODES = [
  "plugin_instance_revision_conflict",
  "plugin_settings_revision_conflict",
];
