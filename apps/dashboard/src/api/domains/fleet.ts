/**
 * Fleet domain helpers over the typed transport: locations,
 * presentation networks, plugins, AirPlay sessions, presentation
 * overrides, and screen groups. Location, presentation-network, and
 * player-policy success bodies are contract-typed and inferred from
 * the generated OpenAPI schemas; other areas still state their local
 * Studio response type explicitly until the contract gains schemas.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type {
  AirplaySession,
  DependencyGraph,
  DisplayControlGroupApplyResult,
  DisplayControlGroupPreview,
  EffectivePolicy,
  LocationInput,
  PluginCatalog,
  PluginSummary,
  PolicyDocument,
  PresentationNetworkInput,
  PresentationOverride,
  ScreenGroup,
  ScreenGroupList,
  SpanStatus,
} from "../types";

export function listLocations() {
  return apiGet("/api/v1/locations");
}

export function createLocation(input: LocationInput, csrfToken: string) {
  return apiPost("/api/v1/locations", {
    body: input,
    csrfToken,
  });
}

export function updateLocation(
  id: string,
  input: LocationInput,
  csrfToken: string,
) {
  return apiPatch("/api/v1/locations/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deleteLocation(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/locations/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listPresentationNetworks() {
  return apiGet("/api/v1/presentation-networks");
}

export function getPresentationNetwork(id: string) {
  return apiGet("/api/v1/presentation-networks/{id}", {
    params: { path: { id } },
  });
}

export function createPresentationNetwork(
  input: PresentationNetworkInput,
  csrfToken: string,
) {
  return apiPost("/api/v1/presentation-networks", {
    body: input,
    csrfToken,
  });
}

export function updatePresentationNetwork(
  id: string,
  input: PresentationNetworkInput,
  csrfToken: string,
) {
  return apiPatch("/api/v1/presentation-networks/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deletePresentationNetwork(id: string, csrfToken: string) {
  return apiDelete("/api/v1/presentation-networks/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function replacePresentationNetworkAssignments(
  id: string,
  screenIds: string[],
  csrfToken: string,
) {
  return apiPut("/api/v1/presentation-networks/{id}/screens", {
    params: { path: { id } },
    body: { screenIds },
    csrfToken,
  });
}

export function getScreenPresentationNetwork(id: string) {
  return apiGet("/api/v1/screens/{id}/presentation-network", {
    params: { path: { id } },
  });
}

export function assignScreenPresentationNetwork(
  screenId: string,
  presentationNetworkId: string,
  csrfToken: string,
) {
  return apiPut("/api/v1/screens/{id}/presentation-network", {
    params: { path: { id: screenId } },
    body: { presentationNetworkId },
    csrfToken,
  });
}

export function unassignScreenPresentationNetwork(
  screenId: string,
  csrfToken: string,
) {
  return apiDelete("/api/v1/screens/{id}/presentation-network", {
    params: { path: { id: screenId } },
    csrfToken,
  });
}

export function testPresentationNetwork(
  id: string,
  screenId: string,
  csrfToken: string,
) {
  return apiPost("/api/v1/presentation-networks/{id}/test", {
    params: { path: { id } },
    body: { screenId },
    csrfToken,
  });
}

export function listPlugins(): Promise<PluginCatalog> {
  return apiGet<"/api/v1/plugins", PluginCatalog>("/api/v1/plugins");
}

export function installPlugin(
  id: string,
  csrfToken: string,
): Promise<PluginSummary> {
  return apiPost<"/api/v1/plugins/{pluginId}/install", PluginSummary>(
    "/api/v1/plugins/{pluginId}/install",
    { params: { path: { pluginId: id } }, csrfToken },
  );
}

export function removePlugin(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/plugins/{pluginId}/installation", {
    params: { path: { pluginId: id } },
    csrfToken,
  });
}

export function getDependencyGraph(): Promise<DependencyGraph> {
  return apiGet<"/api/v1/plugins/dependency-graph", DependencyGraph>(
    "/api/v1/plugins/dependency-graph",
  );
}

export function getAirplaySession(id: string): Promise<AirplaySession> {
  return apiGet<"/api/v1/airplay/sessions/{id}", AirplaySession>(
    "/api/v1/airplay/sessions/{id}",
    { params: { path: { id } } },
  );
}

export function createAirplaySession(
  input: {
    targetType: "screen" | "group";
    targetId: string;
    durationMinutes: 0 | 15 | 30 | 60;
    transport: "auto" | "unicast" | "multicast";
    audioMode: "gateway_only" | "none";
  },
  csrfToken: string,
): Promise<AirplaySession> {
  return apiPost<"/api/v1/airplay/sessions", AirplaySession>(
    "/api/v1/airplay/sessions",
    { body: input, csrfToken },
  );
}

export function stopAirplaySession(
  id: string,
  csrfToken: string,
  reason = "manual_stop",
): Promise<AirplaySession> {
  return apiPost<"/api/v1/airplay/sessions/{id}/stop", AirplaySession>(
    "/api/v1/airplay/sessions/{id}/stop",
    { params: { path: { id } }, body: { reason }, csrfToken },
  );
}

export function listPresentationOverrides(): Promise<{
  items: PresentationOverride[];
  total: number;
}> {
  return apiGet<
    "/api/v1/presentation-overrides",
    { items: PresentationOverride[]; total: number }
  >("/api/v1/presentation-overrides");
}

export function createPresentationOverride(
  input: {
    targetType: "screen" | "group";
    targetId: string;
    contentType: "playlist" | "layout" | "asset";
    contentId: string;
    durationMinutes: 0 | 5 | 15 | 30 | 60;
    afterAction: "resume";
    wakeDisplay: boolean;
  },
  csrfToken: string,
): Promise<PresentationOverride> {
  return apiPost<"/api/v1/presentation-overrides", PresentationOverride>(
    "/api/v1/presentation-overrides",
    { body: input, csrfToken },
  );
}

export function stopPresentationOverride(
  id: string,
  csrfToken: string,
): Promise<PresentationOverride> {
  return apiPost<
    "/api/v1/presentation-overrides/{id}/stop",
    PresentationOverride
  >("/api/v1/presentation-overrides/{id}/stop", {
    params: { path: { id } },
    body: { reason: "Stopped from Tilecast Studio" },
    csrfToken,
  });
}

export async function listScreenGroups(search = ""): Promise<ScreenGroupList> {
  const result = await apiGet<"/api/v1/screen-groups", ScreenGroupList>(
    "/api/v1/screen-groups",
    { params: { query: { page: 1, pageSize: 100, search } } },
  );
  return {
    ...result,
    items: (Array.isArray(result.items) ? result.items : []).map(
      normalizeScreenGroup,
    ),
  };
}

export function normalizeScreenGroup(group: ScreenGroup): ScreenGroup {
  return {
    ...group,
    displayMode: group.displayMode === "span" ? "span" : "mirror",
    screens: Array.isArray(group.screens) ? group.screens : [],
  };
}

export async function getScreenGroup(id: string): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiGet<"/api/v1/screen-groups/{id}", ScreenGroup>(
      "/api/v1/screen-groups/{id}",
      { params: { path: { id } } },
    ),
  );
}

export function getSpanStatus(id: string): Promise<SpanStatus> {
  return apiGet<"/api/v1/screen-groups/{id}/span", SpanStatus>(
    "/api/v1/screen-groups/{id}/span",
    { params: { path: { id } } },
  );
}

export function previewDisplayControlGroup(
  id: string,
  commandType: DisplayControlGroupPreview["commandType"],
): Promise<DisplayControlGroupPreview> {
  return apiGet<
    "/api/v1/screen-groups/{id}/display-control/preview",
    DisplayControlGroupPreview
  >("/api/v1/screen-groups/{id}/display-control/preview", {
    params: { path: { id }, query: { commandType } },
  });
}

export function applyDisplayControlGroup(
  id: string,
  commandType: DisplayControlGroupPreview["commandType"],
  fingerprint: string,
  csrfToken: string,
): Promise<DisplayControlGroupApplyResult> {
  return apiPost<
    "/api/v1/screen-groups/{id}/display-control",
    DisplayControlGroupApplyResult
  >("/api/v1/screen-groups/{id}/display-control", {
    params: { path: { id } },
    body: { commandType, fingerprint },
    csrfToken,
  });
}

export async function updateSpanGeometry(
  id: string,
  input: {
    displayMode?: "mirror" | "span";
    canvas?: { width: number; height: number };
    panels?: SpanStatus["geometry"]["panels"];
  },
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPut<"/api/v1/screen-groups/{id}/span", ScreenGroup>(
      "/api/v1/screen-groups/{id}/span",
      { params: { path: { id } }, body: input, csrfToken },
    ),
  );
}

export async function createScreenGroup(
  input: { name: string; description: string },
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPost<"/api/v1/screen-groups", ScreenGroup>(
      "/api/v1/screen-groups",
      { body: input, csrfToken },
    ),
  );
}

export async function updateScreenGroup(
  id: string,
  input: {
    name: string;
    description: string;
    presentationGatewayScreenId?: string;
    clearPresentationGateway?: boolean;
  },
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPatch<"/api/v1/screen-groups/{id}", ScreenGroup>(
      "/api/v1/screen-groups/{id}",
      { params: { path: { id } }, body: input, csrfToken },
    ),
  );
}

export function deleteScreenGroup(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/screen-groups/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export async function addScreenToGroup(
  id: string,
  screenId: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPost<"/api/v1/screen-groups/{id}/screens", ScreenGroup>(
      "/api/v1/screen-groups/{id}/screens",
      { params: { path: { id } }, body: { screenId }, csrfToken },
    ),
  );
}

export function removeScreenFromGroup(
  id: string,
  screenId: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/screen-groups/{id}/screens/{screenId}", {
    params: { path: { id, screenId } },
    csrfToken,
  });
}

export async function assignSyncGroupPlaylist(
  id: string,
  playlistId: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPut<"/api/v1/screen-groups/{id}/playlist-assignment", ScreenGroup>(
      "/api/v1/screen-groups/{id}/playlist-assignment",
      { params: { path: { id } }, body: { playlistId }, csrfToken },
    ),
  );
}

export async function assignSyncGroupLayout(
  id: string,
  layoutId: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPut<"/api/v1/screen-groups/{id}/playlist-assignment", ScreenGroup>(
      "/api/v1/screen-groups/{id}/playlist-assignment",
      { params: { path: { id } }, body: { layoutId }, csrfToken },
    ),
  );
}

export async function unassignSyncGroupPlaylist(
  id: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiDelete<
      "/api/v1/screen-groups/{id}/playlist-assignment",
      ScreenGroup
    >("/api/v1/screen-groups/{id}/playlist-assignment", {
      params: { path: { id } },
      csrfToken,
    }),
  );
}

export function getGroupPolicy(id: string): Promise<PolicyDocument> {
  return apiGet("/api/v1/screen-groups/{id}/policy", {
    params: { path: { id } },
  });
}

export function putGroupPolicy(
  id: string,
  revision: number,
  priority: number,
  values: Record<string, unknown>,
  csrfToken: string,
): Promise<PolicyDocument> {
  return apiPut("/api/v1/screen-groups/{id}/policy", {
    params: { path: { id } },
    body: { revision, priority, values },
    csrfToken,
  });
}

export function deleteGroupPolicy(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/screen-groups/{id}/policy", {
    params: { path: { id } },
    csrfToken,
  });
}

export function getScreenPolicy(id: string): Promise<PolicyDocument> {
  return apiGet("/api/v1/screens/{id}/policy", {
    params: { path: { id } },
  });
}

export function putScreenPolicy(
  id: string,
  revision: number,
  values: Record<string, unknown>,
  csrfToken: string,
): Promise<PolicyDocument> {
  return apiPut("/api/v1/screens/{id}/policy", {
    params: { path: { id } },
    body: { revision, values },
    csrfToken,
  });
}

export function deleteScreenPolicy(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/screens/{id}/policy", {
    params: { path: { id } },
    csrfToken,
  });
}

export function getEffectivePolicy(id: string): Promise<EffectivePolicy> {
  return apiGet("/api/v1/screens/{id}/effective-policy", {
    params: { path: { id } },
  });
}
