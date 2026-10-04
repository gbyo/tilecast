import type { components } from "@tilecast/api-schema/generated/openapi";
import { apiGet } from "../transport";

export type PlaybackPlan = components["schemas"]["PlaybackPlan"];

/** Omit at for captured server time; an explicit past instant reads history. */
export function getScreenPlaybackPlan(
  id: string,
  options: { at?: string; signal?: AbortSignal } = {},
): Promise<PlaybackPlan> {
  return apiGet("/api/v1/screens/{id}/playback-plan", {
    params: { path: { id }, query: { at: options.at } },
    signal: options.signal,
  });
}
