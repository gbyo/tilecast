import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  playlistZoneUnsupportedItems,
  type PlaylistZoneUnsupportedItem,
} from "@tilecast/presentation-model";
import { api } from "../../api/client";
import type {
  LayoutDocument,
  LayoutPlacement,
  Playlist,
} from "../../api/types";

/**
 * A playlist zone whose Playlist holds items the Player cannot play in a
 * zone. The rule is the shared supported-item contract in
 * `@tilecast/presentation-model`; the server enforces the same rule when a
 * Layout publishes and when it is assigned, so this only reports what would
 * fail there, earlier and with the item names.
 */
export interface PlaylistZoneIssue {
  placementId: string;
  placementName: string;
  playlistId: string;
  playlistName: string;
  items: PlaylistZoneUnsupportedItem[];
}

export const playlistZoneQueryKey = (playlistId: string) =>
  ["layout-zone-playlist", playlistId] as const;

/** The issue for one zone against its Playlist's current items, or null when the zone can play it. */
export function playlistZoneIssue(
  placement: Pick<LayoutPlacement, "id" | "name">,
  playlist: Pick<Playlist, "id" | "name" | "items">,
): PlaylistZoneIssue | null {
  const items = playlistZoneUnsupportedItems(playlist.items);
  if (items.length === 0) return null;
  return {
    placementId: placement.id,
    placementName: placement.name,
    playlistId: playlist.id,
    playlistName: playlist.name,
    items,
  };
}

/** Visible playlist zones only: a hidden zone is not validated by the server either. */
export function playlistZones(document: LayoutDocument | undefined) {
  return (document?.placements ?? []).filter(
    (placement) =>
      placement.type === "playlistZone" &&
      placement.visible !== false &&
      Boolean(placement.playlistId),
  );
}

/**
 * Validates every visible playlist zone of the Layout against its Playlist as
 * it is now. A Playlist can change after a zone references it, so this reads
 * the Playlist itself rather than trusting what was valid when the zone was
 * added, and rechecks when the window regains focus.
 */
export function usePlaylistZoneIssues(document: LayoutDocument | undefined) {
  const zones = useMemo(() => playlistZones(document), [document]);
  const playlistIds = useMemo(
    () => [...new Set(zones.map((zone) => zone.playlistId!))],
    [zones],
  );
  const queries = useQueries({
    queries: playlistIds.map((playlistId) => ({
      queryKey: playlistZoneQueryKey(playlistId),
      queryFn: () => api.playlist(playlistId),
      staleTime: 10_000,
      refetchOnWindowFocus: "always" as const,
    })),
  });
  const playlists = useMemo(() => {
    const byId = new Map<string, Playlist>();
    queries.forEach((query, index) => {
      if (query.data) byId.set(playlistIds[index]!, query.data);
    });
    return byId;
  }, [queries, playlistIds]);
  const issues = useMemo(() => {
    const found: PlaylistZoneIssue[] = [];
    for (const zone of zones) {
      const playlist = playlists.get(zone.playlistId!);
      const issue = playlist ? playlistZoneIssue(zone, playlist) : null;
      if (issue) found.push(issue);
    }
    return found;
  }, [zones, playlists]);
  const byPlacement = useMemo(
    () => new Map(issues.map((issue) => [issue.placementId, issue])),
    [issues],
  );
  return { issues, byPlacement };
}
