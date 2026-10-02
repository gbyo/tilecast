import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import { archivedScreens } from "../api/archivedScreens";

export const SCREEN_STATUS_REFRESH_MS = 10_000;

// Preserve the released keys while consumers migrate to this owner. The
// root also remains the prefix for fleet-wide mutation invalidation.
export const screenKeys = {
  all: ["screens"] as const,
  list: () => screenKeys.all,
  archive: () => [...screenKeys.all, "archive"] as const,
  detail: (id: string) => [...screenKeys.all, id] as const,
  assignment: (id: string) =>
    [...screenKeys.detail(id), "playlist-assignment"] as const,
  commands: (id: string) => [...screenKeys.detail(id), "commands"] as const,
  reliability: (id: string) =>
    [...screenKeys.detail(id), "reliability"] as const,
  playerHistory: (id: string) =>
    [...screenKeys.detail(id), "player-history"] as const,
  pendingPairings: () => [...screenKeys.all, "pairing", "pending"] as const,
  replacementOptions: () =>
    [...screenKeys.all, "pairing-replacement-options"] as const,
  preview: (id: string) => ["screen-preview", id] as const,
  previewCard: (id: string) => ["screen-preview-card", id] as const,
};

export const screenQueries = {
  list: () =>
    queryOptions({ queryKey: screenKeys.list(), queryFn: api.screens }),
  archive: () =>
    queryOptions({ queryKey: screenKeys.archive(), queryFn: archivedScreens }),
  detail: (id: string) =>
    queryOptions({
      queryKey: screenKeys.detail(id),
      queryFn: () => api.screen(id),
    }),
  assignment: (id: string) =>
    queryOptions({
      queryKey: screenKeys.assignment(id),
      queryFn: () => api.playlistAssignment(id),
    }),
  commands: (id: string) =>
    queryOptions({
      queryKey: screenKeys.commands(id),
      queryFn: () => api.screenCommands(id),
    }),
  reliability: (id: string) =>
    queryOptions({
      queryKey: screenKeys.reliability(id),
      queryFn: () => api.screenReliability(id),
    }),
  playerHistory: (id: string) =>
    queryOptions({
      queryKey: screenKeys.playerHistory(id),
      queryFn: () => api.screenPlayerHistory(id),
    }),
  pendingPairings: () =>
    queryOptions({
      queryKey: screenKeys.pendingPairings(),
      queryFn: api.pendingPairings,
    }),
  replacementOptions: () =>
    queryOptions({
      queryKey: screenKeys.replacementOptions(),
      queryFn: api.screens,
    }),
  preview: (id: string) =>
    queryOptions({
      queryKey: screenKeys.preview(id),
      queryFn: () => api.screenPreview(id),
    }),
  previewCard: (id: string) =>
    queryOptions({
      queryKey: screenKeys.previewCard(id),
      queryFn: () => api.screenPreview(id),
    }),
};
