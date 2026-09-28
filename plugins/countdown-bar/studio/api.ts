/**
 * Countdown Bar's dashboard API. The contract is api/openapi.yaml; this is
 * the Studio client for it.
 */
import { studioRequest, type PluginTargeting } from "@tilecast/studio";

export type CountdownBarInput = {
  name: string;
  message: string;
  scheduleType: "weekly" | "one_time";
  targetTime?: string;
  daysOfWeek: number[];
  oneTimeAt?: string;
  timezone: string;
  leadTimeSeconds: number;
  completionText: string;
  showConfetti: boolean;
  displayMode: "overlay" | "push";
  heightPx: number;
  progressFill: "none" | "drain";
  contentPadding: number;
  textScale: number;
  urgencyEnabled: boolean;
  startingSoonSeconds: number;
  urgentSeconds: number;
  pulseSeconds: number;
  enabled: boolean;
  priority: number;
} & PluginTargeting;

export type CountdownBar = CountdownBarInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const base = "/plugins/countdown-bar/instances";

export const countdownBarsQueryKey = ["countdown-bars"] as const;
export const countdownBarQueryKey = (id: string) =>
  ["countdown-bar", id] as const;

export const countdownApi = {
  list: () => studioRequest<{ items: CountdownBar[]; total: number }>(base),
  get: (id: string) => studioRequest<CountdownBar>(`${base}/${id}`),
  create: (input: CountdownBarInput, csrfToken: string) =>
    studioRequest<CountdownBar>(base, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  update: (id: string, input: CountdownBarInput, csrfToken: string) =>
    studioRequest<CountdownBar>(`${base}/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  remove: (id: string, csrfToken: string) =>
    studioRequest<void>(`${base}/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
};
