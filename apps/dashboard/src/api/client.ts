import type { ScreenScope, ScreenScopes, PlayerReleaseImport } from "./types";
import { ApiError } from "./errors";
import {
  approvePairing,
  cancelScreenCommand,
  confirmPowerAssist,
  createScreenCommand,
  getScreen,
  getScreenPreview,
  getScreenReliability,
  listBulkOperations,
  listPendingPairings,
  listScreenCommands,
  listScreenPlayerHistory,
  listScreenSnapshots,
  listScreens,
  normalizeScreen,
  rejectPairing,
  renewLiveStream,
  renewScreenPreview,
  resolvePairing,
  revokeScreen,
  screenLiveStreamUrl,
  screenPreviewImageUrl,
  setScreenEnabled,
  startLiveStream,
  updateScreen,
} from "./domains/screens";
import {
  addPlaylistItem,
  assignLayout,
  assignPlaylist,
  bulkUpdatePlaylistItems,
  createPlaylist,
  deletePlaylist,
  deletePlaylistItem,
  duplicatePlaylist,
  getPlaylist,
  getPlaylistAssignment,
  listPlaylists,
  listPlaylistsPage,
  normalizePlaylist,
  normalizePlaylistAssignment,
  normalizePlaylistList,
  listPlaylistRevisions,
  publishPlaylist,
  reorderPlaylist,
  restorePlaylistRevision,
  setPlaylistTagRule,
  unassignPlaylist,
  updatePlaylist,
  updatePlaylistItem,
} from "./domains/playlists";
import {
  createLayout,
  deleteLayout,
  duplicateLayout,
  getLayout,
  listLayoutRevisions,
  listLayouts,
  listLayoutsPage,
  normalizeLayout,
  normalizeLayoutList,
  publishLayout,
  restoreLayoutRevision,
  saveLayoutDraft,
  updateLayout,
} from "./domains/layouts";
import {
  approveOAuth,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  createPersonalAccessToken,
  denyOAuth,
  describeOAuthApproval,
  getAuthStatus,
  getMfaPasskeyOptions,
  getPasskeyLoginOptions,
  getPasskeyRegistrationOptions,
  getSecurityStatus,
  initialSetup,
  listOAuthGrants,
  listPersonalAccessTokens,
  login,
  logout,
  passkeyLogin,
  regenerateRecoveryCodes,
  registerPasskey,
  removePasskey,
  removeTotp,
  renamePasskey,
  resetUserSecurity,
  revokeOAuthGrant,
  verifyMfa,
} from "./domains/auth";
import {
  approveContentSubmission,
  archiveCampaign,
  cancelContentSchedule,
  comparePublications,
  createCampaign,
  createSchedule,
  decideContentReview,
  deleteSchedule,
  getCampaign,
  getCampaignPreflight,
  getContentSubmission,
  getSchedule,
  listCampaignReleases,
  listCampaigns,
  listCampaignsPage,
  listContentReviews,
  listContentSubmissions,
  listPublicationHistory,
  listSchedules,
  listSchedulesPage,
  previewSchedule,
  publishCampaign,
  publishContentSubmission,
  requestContentChanges,
  restoreCampaignRelease,
  restorePublicationToDraft,
  rollbackPublication,
  scheduleContentSubmission,
  setScheduleEnabled,
  submitContent,
  updateCampaignDraft,
  updateSchedule,
} from "./domains/scheduling";
import {
  activateTakeover,
  applyBulkOperation,
  applySettingsImport,
  cachePlayerRelease,
  cancelTakeover,
  cancelUpdateDeployment,
  checkPlayerReleases,
  createBackup,
  createIntegrationToken,
  createNotificationWebhook,
  createUpdateDeployment,
  deleteBackup,
  deleteNotificationWebhook,
  deletePlayerRelease,
  disconnectGitHub,
  exportSettings,
  getBackupRestorePlan,
  getContentHealth,
  getFleetUptime,
  isSettingsExportDocument,
  getNotificationStatus,
  getPreferences,
  getSettings,
  getSystemIdentity,
  getSystemStatus,
  getUpdateDeployment,
  listBackups,
  listIntegrationTokens,
  listNotificationDeliveries,
  listNotificationWebhooks,
  listPlayerReleases,
  listTakeovers,
  listUpdateDeployments,
  listUsers,
  pollGitHubDeviceAuthorization,
  previewBulkOperation,
  previewSettingsImport,
  resetSettings,
  restoreBackup,
  retryUpdateScreen,
  revokeIntegrationToken,
  runMaintenance,
  sendTestNotification,
  startGitHubDeviceAuthorization,
  testNotificationWebhook,
  undoBulkOperation,
  updateNotificationWebhook,
  updatePreferences,
  updateSettings,
  verifyBackup,
} from "./domains/system";
import {
  addScreenToGroup,
  applyDisplayControlGroup,
  assignScreenPresentationNetwork,
  assignSyncGroupLayout,
  assignSyncGroupPlaylist,
  createAirplaySession,
  createLocation,
  createPresentationNetwork,
  createScreenGroup,
  createPresentationOverride,
  deleteGroupPolicy,
  deleteLocation,
  deletePresentationNetwork,
  deleteScreenGroup,
  deleteScreenPolicy,
  getAirplaySession,
  getDependencyGraph,
  getEffectivePolicy,
  getGroupPolicy,
  getPluginStoreEntry,
  getPresentationNetwork,
  getScreenGroup,
  getScreenPolicy,
  getScreenPresentationNetwork,
  getSpanStatus,
  installPlugin,
  listLocations,
  listPlugins,
  listPluginStore,
  listPresentationNetworks,
  listPresentationOverrides,
  listScreenGroups,
  listScreenGroupsPage,
  normalizeScreenGroup,
  previewDisplayControlGroup,
  putGroupPolicy,
  putScreenPolicy,
  removePlugin,
  removeScreenFromGroup,
  replacePresentationNetworkAssignments,
  stopAirplaySession,
  stopPresentationOverride,
  testPresentationNetwork,
  unassignScreenPresentationNetwork,
  unassignSyncGroupPlaylist,
  updateLocation,
  updatePresentationNetwork,
  updateScreenGroup,
  updateSpanGeometry,
} from "./domains/fleet";

// Normalizers stay importable from the historic location while callers
// migrate to the domain modules.
export { normalizeScreenGroup };
import {
  archiveAssets,
  bulkOrganize,
  cancelUpload,
  completeUpload,
  compileWidgetPreview,
  createContentCollection,
  createContentFolder,
  createContentTag,
  createDataSource,
  createUpload,
  createWebsite,
  createWidget,
  deleteAsset,
  deleteContentCollection,
  deleteContentFolder,
  deleteContentTag,
  deleteDataSource,
  duplicateDataSource,
  duplicateWidget,
  getAsset,
  getContentDefinitions,
  getDataSource,
  getDataSourceDiagnostics,
  getProviderCatalog,
  getWebsiteDiagnostics,
  inspectDataSource,
  inspectSavedDataSource,
  listAssets,
  listContentCollections,
  listContentFolders,
  listContentTags,
  listDataSources,
  listDataSourcesPage,
  normalizeContentDefinitionCatalog,
  normalizeProviderCatalog,
  previewDataSource,
  previewCalendarSource,
  previewDatasetSource,
  previewRecordSource,
  previewStructuredSource,
  previewSavedDataSource,
  restoreAssets,
  retryAsset,
  updateAsset,
  updateContentCollection,
  updateContentFolder,
  updateContentTag,
  updateDataSource,
  updateWebsite,
  updateWidget,
} from "./domains/media";

// Normalizers stay importable from the historic location while callers
// migrate to the domain modules.
export {
  normalizeScreen,
  normalizePlaylist,
  normalizePlaylistAssignment,
  normalizePlaylistList,
  normalizeLayout,
  normalizeLayoutList,
  normalizeProviderCatalog,
  normalizeContentDefinitionCatalog,
  isSettingsExportDocument,
};

type DataResponse<T> = { data: T };
type ErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
};

/**
 * The transport owns the failure type. This re-export keeps the
 * `../api/client` import path working for existing UI code while
 * guaranteeing `instanceof ApiError` sees one class no matter which
 * layer threw.
 */
export { ApiError };

/**
 * One request to the Tilecast API below /api/v1, unwrapping the `data`
 * envelope and raising ApiError for the error envelope. Plugins reach it as
 * `studioRequest` from `@tilecast/studio`.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new ApiError(
      body.error?.message ?? "Tilecast could not complete the request.",
      response.status,
      body.error?.code ?? "unknown_error",
      body.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as DataResponse<T>).data;
}

async function apiFailure(
  response: Response,
  fallback = "Tilecast could not complete the request.",
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as ErrorResponse;
  throw new ApiError(
    body.error?.message ?? fallback,
    response.status,
    body.error?.code ?? "unknown_error",
  );
}

const playerReleaseContentTypes: Record<string, string> = {
  "tilecast-player.apk": "application/vnd.android.package-archive",
  "tilecast-player-update.json": "application/json",
  "tilecast-player-update.json.sig": "text/plain",
  "tilecast-player.AppImage": "application/octet-stream",
  "tilecast-player-update-linux.json": "application/json",
  "tilecast-player-update-linux.json.sig": "text/plain",
};

export function playerReleaseContentType(name: string): string {
  return playerReleaseContentTypes[name] ?? "application/octet-stream";
}

export const api = {
  providerCatalog: getProviderCatalog,
  contentDefinitions: getContentDefinitions,
  compileWidgetPreview,
  uploadWidgetPreview: async (
    id: string,
    image: Blob,
    csrfToken: string,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      `/api/v1/widgets/${encodeURIComponent(id)}/preview-image`,
      {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "image/jpeg",
          "X-CSRF-Token": csrfToken,
        },
        body: image,
        signal,
      },
    );
    if (!response.ok)
      await apiFailure(
        response,
        "The Widget preview image could not be saved.",
      );
  },
  layouts: listLayouts,
  layoutPage: listLayoutsPage,
  layout: getLayout,
  uploadLayoutPreview: async (
    id: string,
    draftRevision: number,
    image: Blob,
    csrfToken: string,
  ) => {
    const response = await fetch(
      `/api/v1/layouts/${encodeURIComponent(id)}/preview-image?${new URLSearchParams({ draftRevision: String(draftRevision) })}`,
      {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "image/jpeg",
          "X-CSRF-Token": csrfToken,
        },
        body: image,
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new ApiError(
        body.error?.message ?? "The Layout preview image could not be saved.",
        response.status,
        body.error?.code ?? "unknown_error",
      );
    }
  },
  createLayout,
  updateLayout,
  saveLayoutDraft,
  publishLayout,
  duplicateLayout,
  deleteLayout,
  layoutRevisions: listLayoutRevisions,
  restoreLayoutRevision,
  playerReleases: listPlayerReleases,
  checkPlayerReleases,
  startGitHubDeviceAuthorization,
  pollGitHubDeviceAuthorization,
  disconnectGitHub,
  cachePlayerRelease,
  deletePlayerRelease,
  uploadPlayerRelease: (
    files: File[],
    csrfToken: string,
    onProgress: (percent: number) => void,
  ) =>
    new Promise<PlayerReleaseImport>((resolve, reject) => {
      const form = new FormData();
      for (const file of files)
        form.append(
          "files",
          new Blob([file], { type: playerReleaseContentType(file.name) }),
          file.name,
        );
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/player-releases/upload");
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-CSRF-Token", csrfToken);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onerror = () =>
        reject(new ApiError("Release upload failed.", 0, "network_error"));
      xhr.onload = () => {
        let body: DataResponse<PlayerReleaseImport> | ErrorResponse = {};
        try {
          body = JSON.parse(xhr.responseText || "{}") as
            DataResponse<PlayerReleaseImport> | ErrorResponse;
        } catch {
          // A proxy may replace a bounded API error with a non-JSON response.
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = body as ErrorResponse;
          reject(
            new ApiError(
              error.error?.message ?? "Release upload failed.",
              xhr.status,
              error.error?.code ?? "unknown_error",
            ),
          );
          return;
        }
        resolve((body as DataResponse<PlayerReleaseImport>).data);
      };
      xhr.send(form);
    }),
  updateDeployments: listUpdateDeployments,
  updateDeployment: getUpdateDeployment,
  retryUpdateScreen,
  createUpdateDeployment,
  cancelUpdateDeployment,
  settings: getSettings,
  users: listUsers,
  updateSettings,
  resetSettings,
  preferences: getPreferences,
  updatePreferences,
  groupPolicy: getGroupPolicy,
  putGroupPolicy,
  deleteGroupPolicy,
  screenPolicy: getScreenPolicy,
  putScreenPolicy,
  deleteScreenPolicy,
  effectivePolicy: getEffectivePolicy,
  systemStatus: getSystemStatus,
  systemIdentity: getSystemIdentity,
  contentHealth: getContentHealth,
  screenSnapshots: listScreenSnapshots,
  playlistRevisions: listPlaylistRevisions,
  restorePlaylistRevision,
  publishPlaylist,
  contentReviews: listContentReviews,
  decideContentReview,
  contentSubmissions: listContentSubmissions,
  contentSubmission: getContentSubmission,
  submitContent,
  approveContentSubmission,
  requestContentChanges,
  publishContentSubmission,
  scheduleContentSubmission,
  cancelContentSchedule,
  publicationHistory: listPublicationHistory,
  comparePublications,
  restorePublicationToDraft,
  rollbackPublication,
  campaigns: listCampaigns,
  campaignPage: listCampaignsPage,
  campaign: getCampaign,
  createCampaign,
  updateCampaignDraft,
  campaignPreflight: getCampaignPreflight,
  campaignReleases: listCampaignReleases,
  restoreCampaignRelease,
  publishCampaign,
  archiveCampaign,
  // Per-user screen scopes stay on the raw request: the server exposes no
  // screen-scopes route for them, so they cannot enter the typed contract.
  userScreenScopes: (userId: string) =>
    request<ScreenScopes>(`/users/${userId}/screen-scopes`),
  putUserScreenScopes: (
    userId: string,
    scopes: ScreenScope[],
    csrfToken: string,
  ) =>
    request<ScreenScopes>(`/users/${userId}/screen-scopes`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ scopes }),
    }),
  integrationTokens: listIntegrationTokens,
  createIntegrationToken,
  revokeIntegrationToken,
  previewBulkOperation,
  applyBulkOperation,
  bulkOperations: listBulkOperations,
  undoBulkOperation,
  notificationStatus: getNotificationStatus,
  notificationDeliveries: listNotificationDeliveries,
  sendTestNotification,
  notificationWebhooks: listNotificationWebhooks,
  createNotificationWebhook,
  updateNotificationWebhook,
  deleteNotificationWebhook,
  testNotificationWebhook,
  backups: listBackups,
  createBackup,
  verifyBackup,
  backupRestorePlan: getBackupRestorePlan,
  restoreBackup,
  deleteBackup,
  runMaintenance,
  exportSettings,
  previewSettingsImport,
  applySettingsImport,
  authStatus: getAuthStatus,
  setup: initialSetup,
  login,
  verifyMfa,
  mfaPasskeyOptions: getMfaPasskeyOptions,
  passkeyLoginOptions: getPasskeyLoginOptions,
  passkeyLogin,
  security: getSecurityStatus,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  removeTotp,
  regenerateRecoveryCodes,
  passkeyRegistrationOptions: getPasskeyRegistrationOptions,
  registerPasskey,
  renamePasskey,
  removePasskey,
  describeOAuthApproval,
  approveOAuth,
  denyOAuth,
  listOAuthGrants,
  revokeOAuthGrant,
  listPersonalAccessTokens,
  createPersonalAccessToken,
  resetUserSecurity,
  logout,
  screens: listScreens,
  locations: listLocations,
  presentationNetworks: listPresentationNetworks,
  presentationNetwork: getPresentationNetwork,
  createPresentationNetwork,
  updatePresentationNetwork,
  deletePresentationNetwork,
  replacePresentationNetworkAssignments,
  screenPresentationNetwork: getScreenPresentationNetwork,
  assignScreenPresentationNetwork,
  unassignScreenPresentationNetwork,
  testPresentationNetwork,
  plugins: listPlugins,
  pluginStore: listPluginStore,
  pluginStoreEntry: getPluginStoreEntry,
  installPlugin,
  removePlugin,
  dependencyGraph: getDependencyGraph,
  createLocation,
  updateLocation,
  deleteLocation,
  pendingPairings: listPendingPairings,
  screen: getScreen,
  screenPreview: getScreenPreview,
  renewScreenPreview,
  screenPreviewImageUrl,
  startLiveStream,
  renewLiveStream,
  screenLiveStreamUrl,
  screenReliability: getScreenReliability,
  screenPlayerHistory: listScreenPlayerHistory,
  airplaySession: getAirplaySession,
  createAirplaySession,
  stopAirplaySession,
  presentationOverrides: listPresentationOverrides,
  createPresentationOverride,
  stopPresentationOverride,
  fleetUptime: getFleetUptime,
  confirmPowerAssist,
  resolvePairing,
  approvePairing,
  rejectPairing,
  updateScreen,
  setScreenEnabled,
  revokeScreen,
  screenCommands: listScreenCommands,
  createScreenCommand,
  cancelScreenCommand,
  takeovers: listTakeovers,
  activateTakeover,
  cancelTakeover,
  assets: listAssets,
  contentFolders: listContentFolders,
  createContentFolder,
  updateContentFolder,
  deleteContentFolder,
  contentCollections: listContentCollections,
  createContentCollection,
  updateContentCollection,
  deleteContentCollection,
  contentTags: listContentTags,
  createContentTag,
  updateContentTag,
  deleteContentTag,
  bulkOrganize,
  archiveAssets,
  restoreAssets,
  asset: getAsset,
  assetPreviewUrl: (id: string) =>
    `/api/v1/assets/${encodeURIComponent(id)}/preview`,
  updateAsset,
  setPlaylistTagRule,
  createWebsite,
  updateWebsite,
  websiteDiagnostics: getWebsiteDiagnostics,
  createWidget,
  updateWidget,
  duplicateWidget,
  listDataSources,
  listDataSourcesPage,
  getDataSource,
  createDataSource,
  updateDataSource,
  duplicateDataSource,
  deleteDataSource,

  dataSourceDiagnostics: getDataSourceDiagnostics,
  previewDataSource,
  previewCalendarSource,
  previewDatasetSource,
  previewRecordSource,
  previewStructuredSource,
  // Report the fields a candidate RSS, Atom, JSON, or CSV connection contains, before a
  // mapping exists, so Studio can offer detected fields rather than typed guesses.
  inspectDataSource,
  // Detect fields for a saved Source. A saved CSV upload's bytes stay on the server, so the
  // editor cannot send a configuration back for detection.
  inspectSavedDataSource,
  // Preview a saved Data Source by id using its full stored configuration
  // (including uploaded CSV content the detail response strips).
  previewSavedDataSource,
  retryAsset,
  deleteAsset,
  createUpload,
  inspectUpload: async (id: string) => {
    const response = await fetch(`/api/v1/uploads/${id}`, {
      method: "HEAD",
      credentials: "same-origin",
    });
    if (!response.ok) return apiFailure(response);
    return {
      offset: Number(response.headers.get("Upload-Offset") ?? 0),
      sizeBytes: Number(response.headers.get("Upload-Length") ?? 0),
      status: response.headers.get("Upload-Status") ?? "pending",
      expiresAt: response.headers.get("Upload-Expires") ?? "",
    };
  },
  uploadChunk: async (
    id: string,
    offset: number,
    chunk: Blob,
    csrfToken: string,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(`/api/v1/uploads/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": String(offset),
        "X-CSRF-Token": csrfToken,
      },
      body: chunk,
      signal,
    });
    if (!response.ok) return apiFailure(response);
    return Number(response.headers.get("Upload-Offset") ?? offset + chunk.size);
  },
  completeUpload,
  cancelUpload,
  playlists: listPlaylists,
  playlistPage: listPlaylistsPage,
  playlist: getPlaylist,
  createPlaylist,
  updatePlaylist,
  duplicatePlaylist,
  deletePlaylist,
  addPlaylistItem,
  updatePlaylistItem,
  deletePlaylistItem,
  reorderPlaylist,
  bulkUpdatePlaylistItems,
  playlistAssignment: getPlaylistAssignment,
  assignPlaylist,
  assignLayout,
  unassignPlaylist,
  screenGroups: listScreenGroups,
  screenGroupPage: listScreenGroupsPage,
  screenGroup: getScreenGroup,
  spanStatus: getSpanStatus,
  displayControlGroupPreview: previewDisplayControlGroup,
  applyDisplayControlGroup,
  updateSpanGeometry,
  createScreenGroup,
  updateScreenGroup,
  deleteScreenGroup,
  addScreenToGroup,
  removeScreenFromGroup,
  assignSyncGroupPlaylist,
  assignSyncGroupLayout,
  unassignSyncGroupPlaylist,
  schedules: listSchedules,
  schedulePage: listSchedulesPage,
  schedule: getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  setScheduleEnabled,
  previewSchedule,
};
