import { studioRequest } from "@tilecast/studio";
import type {
  NWSAlertMonitor,
  NWSAlertRule,
  NWSAlertRuleInput,
  NWSAlertSettings,
  NWSZone,
  Playlist,
  TargetItem,
} from "./types";

// Both list endpoints cap pages at 100 rows. Rule targets must offer every
// group and playlist, so aggregate every page instead of the first one.
async function fetchAll<T>(
  path: string,
): Promise<{ items: T[]; total: number }> {
  const pageSize = 100;
  const first = await studioRequest<{ items: T[]; total: number }>(
    `${path}?page=1&pageSize=${pageSize}`,
  );
  const items = [...first.items];
  let page = 2;
  while (items.length < first.total) {
    const next = await studioRequest<{ items: T[]; total: number }>(
      `${path}?page=${page}&pageSize=${pageSize}`,
    );
    if (next.items.length === 0) {
      break;
    }
    items.push(...next.items);
    page += 1;
  }
  return { items, total: first.total };
}

export const api = {
  nwsAlertSettings: () => studioRequest<NWSAlertSettings>("/alerts/nws"),
  nwsZones: (area: string) =>
    studioRequest<{ items: NWSZone[] }>(
      `/alerts/nws/zones?area=${encodeURIComponent(area)}`,
    ),
  updateNWSAlertMonitor: (
    input: {
      enabled: boolean;
      areas: string[];
      zones: string[];
      pollIntervalSeconds: number;
    },
    csrfToken: string,
  ) =>
    studioRequest<NWSAlertMonitor>("/alerts/nws/monitor", {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  pollNWSAlerts: (csrfToken: string) =>
    studioRequest<NWSAlertSettings>("/alerts/nws/poll", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  createNWSAlertRule: (input: NWSAlertRuleInput, csrfToken: string) =>
    studioRequest<NWSAlertRule>("/alerts/nws/rules", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateNWSAlertRule: (
    id: string,
    input: NWSAlertRuleInput,
    csrfToken: string,
  ) =>
    studioRequest<NWSAlertRule>(`/alerts/nws/rules/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteNWSAlertRule: (id: string, csrfToken: string) =>
    studioRequest<{ id: string; deleted: boolean }>(`/alerts/nws/rules/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  screens: () =>
    studioRequest<{ items: TargetItem[]; total: number }>("/screens"),
  screenGroups: () => fetchAll<TargetItem>("/screen-groups"),
  playlists: () => fetchAll<Playlist>("/playlists"),
};
