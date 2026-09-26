import { studioRequest } from "@tilecast/studio";
import type { NWSAlertMonitor, NWSAlertRule, NWSAlertRuleInput, NWSAlertSettings, NWSZone, Playlist, TargetItem } from "./types";

export const api = {
  nwsAlertSettings: () => studioRequest<NWSAlertSettings>("/alerts/nws"),
  nwsZones: (area: string) => studioRequest<{ items: NWSZone[] }>(`/alerts/nws/zones?area=${encodeURIComponent(area)}`),
  updateNWSAlertMonitor: (input: { enabled: boolean; areas: string[]; zones: string[]; pollIntervalSeconds: number }, csrfToken: string) =>
    studioRequest<NWSAlertMonitor>("/alerts/nws/monitor", { method: "PUT", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(input) }),
  pollNWSAlerts: (csrfToken: string) => studioRequest<NWSAlertSettings>("/alerts/nws/poll", { method: "POST", headers: { "X-CSRF-Token": csrfToken } }),
  createNWSAlertRule: (input: NWSAlertRuleInput, csrfToken: string) => studioRequest<NWSAlertRule>("/alerts/nws/rules", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(input) }),
  updateNWSAlertRule: (id: string, input: NWSAlertRuleInput, csrfToken: string) => studioRequest<NWSAlertRule>(`/alerts/nws/rules/${id}`, { method: "PUT", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify(input) }),
  deleteNWSAlertRule: (id: string, csrfToken: string) => studioRequest<{ id: string; deleted: boolean }>(`/alerts/nws/rules/${id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrfToken } }),
  screens: () => studioRequest<{ items: TargetItem[]; total: number }>("/screens"),
  screenGroups: () => studioRequest<{ items: TargetItem[]; total: number }>("/screen-groups?page=1&pageSize=100"),
  playlists: () => studioRequest<{ items: Playlist[]; total: number }>("/playlists?page=1&pageSize=100"),
};
