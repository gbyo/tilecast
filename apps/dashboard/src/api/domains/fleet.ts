/**
 * Fleet domain helpers over the typed transport: locations,
 * presentation networks, plugins, AirPlay sessions, presentation
 * overrides, and screen groups. Location, presentation-network,
 * player-policy, group, span, and display-control success bodies are
 * contract-typed and inferred from the generated OpenAPI schemas.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import { fetchAllPages } from "../pagination";
import type { components } from "@tilecast/api-schema/generated/openapi";
import type {
  AirplaySession,
  DependencyGraph,
  DisplayControlGroupApplyResult,
  GitHubInstallReview,
  InstalledPackage,
  PackageUpdateCheck,
  PackageUpdateResult,
  PluginMarketplaceStatus,
  PluginStore,
  PluginStoreEntry,
  DisplayControlGroupPreview,
  EffectivePolicy,
  LocationInput,
  PluginCatalog,
  PolicyDocument,
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

/** Creating a network requires its secret; updating may omit it to keep it. */
export type PresentationNetworkCreateInput =
  components["schemas"]["PresentationNetworkCreateInput"];
export type PresentationNetworkUpdateInput =
  components["schemas"]["PresentationNetworkUpdateInput"];

export function createPresentationNetwork(
  input: PresentationNetworkCreateInput,
  csrfToken: string,
) {
  return apiPost("/api/v1/presentation-networks", {
    body: input,
    csrfToken,
  });
}

export function updatePresentationNetwork(
  id: string,
  input: PresentationNetworkUpdateInput,
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
  return apiGet("/api/v1/plugins");
}

export function listPluginStore(): Promise<PluginStore> {
  return apiGet("/api/v1/plugin-store");
}

export function getPluginStoreEntry(
  packageId: string,
): Promise<PluginStoreEntry> {
  return apiGet("/api/v1/plugin-store/{packageId}", {
    params: { path: { packageId } },
  });
}

/**
 * Wire shape of an installed plugin from the generated contract. The
 * install route answers 200 when the plugin was already installed and
 * 201 when this request installs it; both carry the same representation.
 */
export type WireInstalledPlugin = components["schemas"]["CatalogPlugin"];

export function installPlugin(
  id: string,
  csrfToken: string,
): Promise<WireInstalledPlugin> {
  return apiPost("/api/v1/plugins/{pluginId}/install", {
    params: { path: { pluginId: id } },
    csrfToken,
  });
}

export function removePlugin(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/plugins/{pluginId}/installation", {
    params: { path: { pluginId: id } },
    csrfToken,
  });
}

/** Refresh the official Tilecast marketplace now; answers its cache status. */
export function refreshMarketplaceCatalog(
  csrfToken: string,
): Promise<{ marketplace: PluginMarketplaceStatus }> {
  return apiPost("/api/v1/plugin-store/marketplace/refresh", { csrfToken });
}

/**
 * Resolve a public GitHub repository to its install review. Persists
 * nothing; installing re-resolves fresh.
 */
export function resolveGitHubRepository(
  repository: string,
  csrfToken: string,
): Promise<GitHubInstallReview> {
  return apiPost("/api/v1/plugin-store/resolve-github", {
    body: { repository },
    csrfToken,
  });
}

/**
 * Install the store entry. A marketplace entry installs with no body; a
 * custom entry installs when the body names its repository.
 */
export function installStorePackage(
  packageId: string,
  csrfToken: string,
  repository?: string,
): Promise<InstalledPackage> {
  return apiPost("/api/v1/plugin-store/{packageId}/install", {
    params: { path: { packageId } },
    body: repository === undefined ? undefined : { repository },
    csrfToken,
  });
}

/** Every installed extension package. */
export function listPackages(): Promise<InstalledPackage[]> {
  return apiGet("/api/v1/packages");
}

export function getPackage(packageId: string): Promise<InstalledPackage> {
  return apiGet("/api/v1/packages/{packageId}", {
    params: { path: { packageId } },
  });
}

/**
 * Resolve the latest artifact for an installed package without
 * activating anything.
 */
export function checkPackageUpdate(
  packageId: string,
  csrfToken: string,
): Promise<PackageUpdateCheck> {
  return apiPost("/api/v1/packages/{packageId}/update-check", {
    params: { path: { packageId } },
    csrfToken,
  });
}

/** Activate the digest an update check approved. */
export function applyPackageUpdate(
  packageId: string,
  digest: string,
  csrfToken: string,
): Promise<PackageUpdateResult> {
  return apiPost("/api/v1/packages/{packageId}/update", {
    params: { path: { packageId } },
    body: { digest },
    csrfToken,
  });
}

/** Restore the previous activation. */
export function rollbackPackage(
  packageId: string,
  csrfToken: string,
): Promise<InstalledPackage> {
  return apiPost("/api/v1/packages/{packageId}/rollback", {
    params: { path: { packageId } },
    csrfToken,
  });
}

/**
 * Delete the installation and its contribution rows. The custom source,
 * when any, survives for reinstall.
 */
export function removePackage(
  packageId: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/packages/{packageId}", {
    params: { path: { packageId } },
    csrfToken,
  });
}

export function getDependencyGraph(): Promise<DependencyGraph> {
  return apiGet("/api/v1/plugins/dependency-graph");
}

export type WireAirplaySession = components["schemas"]["AirplaySession"];

/**
 * The wire carries null for no audio screen, no Presentation Network,
 * and no end timestamp; the Studio view models those as absent.
 */
export function normalizeAirplaySession(
  wire: WireAirplaySession,
): AirplaySession {
  return {
    ...wire,
    audioScreenId: wire.audioScreenId ?? undefined,
    endedAt: wire.endedAt ?? undefined,
    presentationNetworkId: wire.presentationNetworkId ?? undefined,
  };
}

export async function getAirplaySession(id: string): Promise<AirplaySession> {
  return normalizeAirplaySession(
    await apiGet("/api/v1/airplay/sessions/{id}", {
      params: { path: { id } },
    }),
  );
}

export async function createAirplaySession(
  input: {
    targetType: "screen" | "group";
    targetId: string;
    durationMinutes: 0 | 15 | 30 | 60;
    transport: "auto" | "unicast" | "multicast";
    audioMode: "gateway_only" | "none";
  },
  csrfToken: string,
): Promise<AirplaySession> {
  return normalizeAirplaySession(
    await apiPost("/api/v1/airplay/sessions", { body: input, csrfToken }),
  );
}

export async function stopAirplaySession(
  id: string,
  csrfToken: string,
  reason = "manual_stop",
): Promise<AirplaySession> {
  return normalizeAirplaySession(
    await apiPost("/api/v1/airplay/sessions/{id}/stop", {
      params: { path: { id } },
      body: { reason },
      csrfToken,
    }),
  );
}

export function listPresentationOverrides(): Promise<{
  items: PresentationOverride[];
  total: number;
}> {
  return apiGet("/api/v1/presentation-overrides");
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
  return apiPost("/api/v1/presentation-overrides", {
    body: input,
    csrfToken,
  });
}

export function stopPresentationOverride(
  id: string,
  csrfToken: string,
): Promise<PresentationOverride> {
  return apiPost("/api/v1/presentation-overrides/{id}/stop", {
    params: { path: { id } },
    body: { reason: "Stopped from Tilecast Studio" },
    csrfToken,
  });
}

export async function listScreenGroupsPage(
  search = "",
  page = 1,
): Promise<ScreenGroupList> {
  const result = await apiGet("/api/v1/screen-groups", {
    params: { query: { page, pageSize: 100, search } },
  });
  return {
    ...result,
    items: (Array.isArray(result.items) ? result.items : []).map(
      normalizeScreenGroup,
    ),
  };
}

export function listScreenGroups(search = ""): Promise<ScreenGroupList> {
  return fetchAllPages((page) => listScreenGroupsPage(search, page));
}

/** Wire shapes of a screen group and span status from the generated contract. */
export type WireScreenGroup = components["schemas"]["ScreenGroup"];
export type WireSpanStatus = components["schemas"]["SpanStatus"];

export function normalizeScreenGroup(
  group: ScreenGroup | WireScreenGroup,
): ScreenGroup {
  return {
    ...group,
    displayMode: group.displayMode === "span" ? "span" : "mirror",
    screens: Array.isArray(group.screens) ? group.screens : [],
  };
}

export async function getScreenGroup(id: string): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiGet("/api/v1/screen-groups/{id}", {
      params: { path: { id } },
    }),
  );
}

export async function getSpanStatus(id: string): Promise<SpanStatus> {
  return normalizeSpanStatus(
    await apiGet("/api/v1/screen-groups/{id}/span", {
      params: { path: { id } },
    }),
  );
}

/**
 * The contract leaves panel bezels optional; the server always sends
 * them and the Studio view requires them, so the bridge defaults
 * missing edges to zero rather than failing the call.
 */
export function normalizeSpanStatus(status: WireSpanStatus): SpanStatus {
  return {
    ...status,
    geometry: {
      ...status.geometry,
      panels: (Array.isArray(status.geometry.panels)
        ? status.geometry.panels
        : []
      ).map((panel) => ({
        ...panel,
        bezelLeft: panel.bezelLeft ?? 0,
        bezelTop: panel.bezelTop ?? 0,
        bezelRight: panel.bezelRight ?? 0,
        bezelBottom: panel.bezelBottom ?? 0,
      })),
    },
    preparations: Array.isArray(status.preparations) ? status.preparations : [],
  };
}

export async function previewDisplayControlGroup(
  id: string,
  commandType: DisplayControlGroupPreview["commandType"],
): Promise<DisplayControlGroupPreview> {
  const preview = await apiGet(
    "/api/v1/screen-groups/{id}/display-control/preview",
    { params: { path: { id }, query: { commandType } } },
  );
  // Memberless groups serialize the preview selection as null; the
  // Studio view reads an empty selection.
  return { ...preview, screens: preview.screens ?? [] };
}

export function applyDisplayControlGroup(
  id: string,
  commandType: DisplayControlGroupPreview["commandType"],
  fingerprint: string,
  csrfToken: string,
): Promise<DisplayControlGroupApplyResult> {
  return apiPost("/api/v1/screen-groups/{id}/display-control", {
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
    await apiPut("/api/v1/screen-groups/{id}/span", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
  );
}

export async function createScreenGroup(
  input: { name: string; description: string },
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPost("/api/v1/screen-groups", { body: input, csrfToken }),
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
    await apiPatch("/api/v1/screen-groups/{id}", {
      params: { path: { id } },
      body: input,
      csrfToken,
    }),
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
    await apiPost("/api/v1/screen-groups/{id}/screens", {
      params: { path: { id } },
      body: { screenId },
      csrfToken,
    }),
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
    await apiPut("/api/v1/screen-groups/{id}/playlist-assignment", {
      params: { path: { id } },
      body: { playlistId },
      csrfToken,
    }),
  );
}

export async function assignSyncGroupLayout(
  id: string,
  layoutId: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiPut("/api/v1/screen-groups/{id}/playlist-assignment", {
      params: { path: { id } },
      body: { layoutId },
      csrfToken,
    }),
  );
}

export async function unassignSyncGroupPlaylist(
  id: string,
  csrfToken: string,
): Promise<ScreenGroup> {
  return normalizeScreenGroup(
    await apiDelete("/api/v1/screen-groups/{id}/playlist-assignment", {
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
