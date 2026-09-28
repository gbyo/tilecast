/**
 * Screen domain helpers over the typed transport. Wire shapes come from
 * the generated OpenAPI contract; the handwritten view models in
 * ../types.ts stay, with `normalizeScreen` bridging the two where the
 * server is more lenient than the contract (or vice versa).
 */
import { apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type { components } from "@tilecast/api-schema/generated/openapi";
import type {
  BulkOperation,
  PairingRequest,
  PlayerCommand,
  PlayerHistory,
  PowerAssistResults,
  ReliabilityStatus,
  Screen,
  ScreenSnapshotList,
} from "../types";

/** Wire shape of a screen from the generated contract. */
export type WireScreen = components["schemas"]["Screen"];

export function normalizeScreen(
  screen: Screen | WireScreen | null | undefined,
): Screen {
  const source = screen ?? ({} as Screen);
  const nowPlayingType =
    source.nowPlayingType === "playlist" ||
    source.nowPlayingType === "presentation"
      ? source.nowPlayingType
      : undefined;
  // The server stores "" for an unknown player family; Studio models that
  // as absent, matching how the update tabs fall back to the platform.
  const family = (source as { playerFamily?: unknown }).playerFamily;
  return {
    ...source,
    nowPlayingType,
    playerFamily:
      family === "android" || family === "electron-linux" || family === "edge"
        ? family
        : undefined,
    deviceManufacturer:
      typeof source.deviceManufacturer === "string"
        ? source.deviceManufacturer
        : "",
  };
}

export async function listScreens(): Promise<{
  items: Screen[];
  total: number;
}> {
  const result = await apiGet("/api/v1/screens");
  return {
    items: (Array.isArray(result.items) ? result.items : []).map(
      normalizeScreen,
    ),
    total: result.total ?? 0,
  };
}

export async function getScreen(id: string): Promise<Screen> {
  return normalizeScreen(
    await apiGet("/api/v1/screens/{id}", { params: { path: { id } } }),
  );
}

export async function getScreenReliability(
  id: string,
): Promise<ReliabilityStatus> {
  const wire = await apiGet("/api/v1/screens/{id}/reliability", {
    params: { path: { id } },
  });
  return normalizeReliability(wire);
}

/**
 * The reliability endpoint returns a role-conditional diagnostics bag
 * (see internal/httpapi/reliability.go): fields vary by player state
 * and managers see package details viewers do not, so the contract
 * types it as an open map and Studio reads the partial
 * ReliabilityStatus view. Non-object payloads yield an empty view
 * rather than a transport error.
 */
function normalizeReliability(wire: unknown): ReliabilityStatus {
  if (typeof wire !== "object" || wire === null) return {};
  return wire as ReliabilityStatus;
}

export async function listScreenPlayerHistory(id: string): Promise<{
  items: PlayerHistory[];
  total: number;
}> {
  const result = await apiGet("/api/v1/screens/{id}/player-history", {
    params: { path: { id } },
  });
  return {
    ...result,
    items: Array.isArray(result.items) ? result.items : [],
  };
}

export function listScreenSnapshots(
  screenId: string,
  limit = 50,
): Promise<ScreenSnapshotList> {
  return apiGet("/api/v1/screens/{id}/snapshots", {
    params: { path: { id: screenId }, query: { limit } },
  });
}

export function listPendingPairings(): Promise<{
  items: PairingRequest[];
  total: number;
}> {
  return apiGet("/api/v1/screens/pairing/pending");
}

export function listBulkOperations(limit = 10): Promise<BulkOperation[]> {
  return apiGet("/api/v1/screens/bulk/operations", {
    params: { query: { limit } },
  });
}

export function confirmPowerAssist(
  id: string,
  // lastTestedAt is response-only: strict decoding rejects unknown fields.
  results: Omit<PowerAssistResults, "lastTestedAt">,
  csrfToken: string,
): Promise<{ screenId: string; lastTestedAt: string }> {
  return apiPut("/api/v1/screens/{id}/power-assist", {
    params: { path: { id } },
    body: results,
    csrfToken,
  });
}

export function resolvePairing(code: string): Promise<PairingRequest> {
  return apiPost("/api/v1/screens/pairing/resolve", { body: { code } });
}

export async function approvePairing(
  id: string,
  input: {
    name: string;
    locationId?: string;
    roomName: string;
    roomNumber: string;
    description: string;
    replaceExistingCredential: boolean;
    replaceHardware?: boolean;
    replacementScreenId?: string;
  },
  csrfToken: string,
): Promise<Screen> {
  return normalizeScreen(
    await apiPost("/api/v1/screens/pairing/{id}/approve", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export function rejectPairing(
  id: string,
  reason: string,
  csrfToken: string,
): Promise<void> {
  return apiPost("/api/v1/screens/pairing/{id}/reject", {
    params: { path: { id } },
    body: { reason },
    csrfToken,
  });
}

export async function updateScreen(
  id: string,
  input: {
    name: string;
    locationId?: string;
    roomName: string;
    roomNumber: string;
    description: string;
  },
  csrfToken: string,
): Promise<Screen> {
  return normalizeScreen(
    await apiPatch<"/api/v1/screens/{id}", Screen>("/api/v1/screens/{id}", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export function setScreenEnabled(
  id: string,
  enabled: boolean,
  csrfToken: string,
): Promise<void> {
  const path = enabled
    ? ("/api/v1/screens/{id}/enable" as const)
    : ("/api/v1/screens/{id}/disable" as const);
  return apiPost(path, { params: { path: { id } }, csrfToken });
}

export function revokeScreen(
  id: string,
  reason: string,
  csrfToken: string,
): Promise<void> {
  return apiPost("/api/v1/screens/{id}/revoke", {
    params: { path: { id } },
    body: { reason },
    csrfToken,
  });
}

/** Wire shape of a player command from the generated contract. */
export type WirePlayerCommand = components["schemas"]["PlayerCommand"];

/**
 * The server sends explicit null for command legs that have not happened
 * yet; the Studio view models those as absent.
 */
export function normalizePlayerCommand(wire: WirePlayerCommand): PlayerCommand {
  return {
    ...wire,
    payload: wire.payload ?? {},
    deliveredAt: wire.deliveredAt ?? undefined,
    acknowledgedAt: wire.acknowledgedAt ?? undefined,
    completedAt: wire.completedAt ?? undefined,
    resultCode: wire.resultCode ?? undefined,
    resultMessage: wire.resultMessage ?? undefined,
  };
}

export function listScreenCommands(id: string): Promise<{
  items: PlayerCommand[];
  total: number;
}> {
  return apiGet("/api/v1/screens/{id}/commands", {
    params: { path: { id } },
  }).then((result) => ({
    ...result,
    items: result.items.map(normalizePlayerCommand),
  }));
}

export function createScreenCommand(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  csrfToken: string,
): Promise<{ id: string; state: string; expiresAt: string }> {
  return apiPost("/api/v1/screens/{id}/commands", {
    params: { path: { id } },
    body: { type, payload },
    csrfToken,
  });
}

export function cancelScreenCommand(
  screenId: string,
  commandId: string,
  csrfToken: string,
): Promise<{ id: string; state: string }> {
  return apiPost("/api/v1/screens/{id}/commands/{commandId}/cancel", {
    params: { path: { id: screenId, commandId } },
    csrfToken,
  });
}
