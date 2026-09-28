/**
 * Playlist domain helpers over the typed transport. Playlist CRUD and
 * revision success bodies are contract-typed and inferred from the
 * generated OpenAPI schemas; the handwritten view models in ../types.ts
 * stay, with the playlist normalizers bridging wire and view shapes.
 * Publish and screen playlist-assignment results stay local until the
 * contract models them.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type { components } from "@tilecast/api-schema/generated/openapi";
import type {
  Playlist,
  PlaylistAssignment,
  PlaylistBulkItemUpdateInput,
  PlaylistItem,
  PlaylistItemInput,
  PlaylistList,
  PlaylistRestoreResult,
  PlaylistRevisionList,
} from "../types";

/** Wire shapes of a playlist and playlist list from the generated contract. */
export type WirePlaylist = components["schemas"]["Playlist"];
export type WirePlaylistItem = components["schemas"]["PlaylistItem"];
export type WirePlaylistList = components["schemas"]["PlaylistList"];

/**
 * The contract leaves item assetStatus an open string: items that point
 * at a Layout with no published revision report `draft`, outside the
 * media lifecycle the closed Studio AssetStatus models. The view keeps
 * the closed type and the runtime value passes through, matching what
 * the untyped transport delivered before this slice.
 */
export function normalizePlaylistItem(
  item: PlaylistItem | WirePlaylistItem,
): PlaylistItem {
  return {
    ...item,
    assetStatus: item.assetStatus as PlaylistItem["assetStatus"],
  };
}

export function normalizePlaylist(
  playlist: Playlist | WirePlaylist | null | undefined,
): Playlist {
  const source = playlist ?? ({} as Playlist);
  return {
    ...source,
    items: (Array.isArray(source.items) ? source.items : []).map(
      normalizePlaylistItem,
    ),
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    layoutUsage: Array.isArray(source.layoutUsage) ? source.layoutUsage : [],
    // List rows serialize detail-only usage and dataSourceIds as null;
    // the Studio view models both as absent.
    usage: source.usage ?? undefined,
    dataSourceIds: source.dataSourceIds ?? undefined,
    hasUnpublishedChanges: Boolean(source.hasUnpublishedChanges),
  };
}

export function normalizePlaylistList(
  result: PlaylistList | WirePlaylistList | null | undefined,
): PlaylistList {
  const source = result ?? ({} as PlaylistList);
  return {
    ...source,
    items: (Array.isArray(source.items) ? source.items : []).map(
      normalizePlaylist,
    ),
  };
}

export function normalizePlaylistAssignment(
  assignment: PlaylistAssignment | null | undefined,
): PlaylistAssignment {
  const source = assignment ?? ({} as PlaylistAssignment);
  return {
    ...source,
    synchronizationStatus:
      typeof source.synchronizationStatus === "string"
        ? source.synchronizationStatus
        : "not_reported",
    groups: Array.isArray(source.groups) ? source.groups : [],
    relevantSchedules: Array.isArray(source.relevantSchedules)
      ? source.relevantSchedules
      : [],
  };
}

export async function listPlaylists(search = ""): Promise<PlaylistList> {
  return normalizePlaylistList(
    await apiGet("/api/v1/playlists", {
      params: { query: { page: 1, pageSize: 100, search } },
    }),
  );
}

export async function getPlaylist(id: string): Promise<Playlist> {
  return normalizePlaylist(
    await apiGet("/api/v1/playlists/{id}", { params: { path: { id } } }),
  );
}

export async function createPlaylist(
  input: { name: string; description: string; sourceType: "static" | "tag" },
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPost("/api/v1/playlists", { body: input, csrfToken }),
  );
}

export async function updatePlaylist(
  id: string,
  input: { name: string; description: string },
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPatch("/api/v1/playlists/{id}", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export async function duplicatePlaylist(
  id: string,
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPost("/api/v1/playlists/{id}/duplicate", {
      params: { path: { id } },
      csrfToken,
    }),
  );
}

export function deletePlaylist(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/playlists/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export async function addPlaylistItem(
  id: string,
  input: PlaylistItemInput,
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPost("/api/v1/playlists/{id}/items", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export async function updatePlaylistItem(
  id: string,
  itemId: string,
  input: PlaylistItemInput,
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPatch("/api/v1/playlists/{id}/items/{itemId}", {
      params: { path: { id, itemId } },
      body: input,
      csrfToken,
    }),
  );
}

export async function deletePlaylistItem(
  id: string,
  itemId: string,
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiDelete("/api/v1/playlists/{id}/items/{itemId}", {
      params: { path: { id, itemId } },
      csrfToken,
    }),
  );
}

export async function reorderPlaylist(
  id: string,
  itemIds: string[],
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPut("/api/v1/playlists/{id}/items/order", {
      params: { path: { id } },
      body: { itemIds },
      csrfToken,
    }),
  );
}

export async function bulkUpdatePlaylistItems(
  id: string,
  input: PlaylistBulkItemUpdateInput,
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPut("/api/v1/playlists/{id}/items/bulk", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export async function getPlaylistAssignment(
  screenId: string,
): Promise<PlaylistAssignment> {
  return normalizePlaylistAssignment(
    await apiGet("/api/v1/screens/{id}/playlist-assignment", {
      params: { path: { id: screenId } },
    }),
  );
}

export async function assignPlaylist(
  screenId: string,
  playlistId: string,
  csrfToken: string,
): Promise<PlaylistAssignment> {
  return normalizePlaylistAssignment(
    await apiPut("/api/v1/screens/{id}/playlist-assignment", {
      params: { path: { id: screenId } },
      body: { playlistId },
      csrfToken,
    }),
  );
}

export async function assignLayout(
  screenId: string,
  layoutId: string,
  csrfToken: string,
): Promise<PlaylistAssignment> {
  return normalizePlaylistAssignment(
    await apiPut("/api/v1/screens/{id}/playlist-assignment", {
      params: { path: { id: screenId } },
      body: { layoutId },
      csrfToken,
    }),
  );
}

export async function unassignPlaylist(
  screenId: string,
  csrfToken: string,
): Promise<PlaylistAssignment> {
  return normalizePlaylistAssignment(
    await apiDelete("/api/v1/screens/{id}/playlist-assignment", {
      params: { path: { id: screenId } },
      csrfToken,
    }),
  );
}

export function listPlaylistRevisions(
  playlistId: string,
): Promise<PlaylistRevisionList> {
  return apiGet("/api/v1/playlists/{id}/revisions", {
    params: { path: { id: playlistId } },
  });
}

export function restorePlaylistRevision(
  playlistId: string,
  revision: number,
  csrfToken: string,
): Promise<PlaylistRestoreResult> {
  return apiPost("/api/v1/playlists/{id}/revisions/{revision}/restore", {
    params: { path: { id: playlistId, revision: String(revision) } },
    csrfToken,
  });
}

export function publishPlaylist(
  id: string,
  expectedDraftRevision: number,
  csrfToken: string,
): Promise<unknown> {
  return apiPost("/api/v1/playlists/{id}/publish", {
    params: { path: { id } },
    body: { expectedDraftRevision },
    csrfToken,
  });
}

export async function setPlaylistTagRule(
  id: string,
  input: {
    enabled: boolean;
    match: "any" | "all";
    imageDurationMs: number;
    tagIds: string[];
  },
  csrfToken: string,
): Promise<Playlist> {
  return normalizePlaylist(
    await apiPut("/api/v1/playlists/{id}/tag-rule", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}
