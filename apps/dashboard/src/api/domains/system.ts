/**
 * System administration domain helpers over the typed transport: player
 * releases, update deployments, takeovers, settings, users, preferences,
 * integration tokens, notifications, backups, and maintenance. Player
 * release, deployment, settings, preference, takeover, and notification
 * success bodies are contract-typed and inferred from the generated
 * schemas. Takeover and deployment rows normalize wire nulls to absent
 * optionals. Binary release uploads
 * stay on XHR in ../client.ts: upload progress is an explicitly
 * exceptional transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import { ApiError } from "../errors";
import type { components } from "@tilecast/api-schema/generated/openapi";
import {
  normalizePlayerFamily,
  normalizePlayerPlatform,
} from "../../playerPlatform";
import type {
  BackupJob,
  BackupList,
  BackupRestorePlan,
  BulkOperation,
  BulkOperationRequest,
  BulkPreview,
  ContentHealthReport,
  IntegrationScope,
  IntegrationToken,
  IntegrationTokenCreated,
  MaintenanceAction,
  ManagedUser,
  NotificationCategory,
  NotificationDelivery,
  NotificationStatus,
  NotificationWebhook,
  NotificationWebhookCreated,
  PlayerRelease,
  PlayerReleaseList,
  SettingsDocument,
  SettingsExportDocument,
  SystemIdentity,
  SystemStatus,
  Takeover,
  UpdateDeployment,
  UpdateDeploymentDetail,
  UpdateDeploymentMode,
  UptimeReport,
  UptimeWindow,
  User,
} from "../types";

export function getSystemIdentity(): Promise<SystemIdentity> {
  return apiGet("/api/v1/system/identity");
}

/** Wire shape of player releases; family and platform arrive as open strings. */
export type WirePlayerRelease = components["schemas"]["PlayerRelease"];

/**
 * Narrow a wire release to the families Studio knows. Unknown values arrive
 * as absent from the lists: Studio has no tab for a family it does not
 * know, and must not show its releases under another family's tab.
 */
export function normalizePlayerRelease(
  wire: WirePlayerRelease,
): PlayerRelease | undefined {
  const platform = normalizePlayerPlatform(wire.platform);
  const playerFamily = normalizePlayerFamily(wire.playerFamily);
  if (platform === undefined || playerFamily === undefined) return undefined;
  return { ...wire, platform, playerFamily };
}

export async function listPlayerReleases(): Promise<PlayerReleaseList> {
  const result = await apiGet("/api/v1/player-releases");
  return {
    repository: result.repository,
    lastCheckedAt: result.lastCheckedAt ?? undefined,
    providerError: result.providerError ?? undefined,
    manifestKeyConfigured: result.manifestKeyConfigured,
    githubAuth: result.githubAuth,
    items: result.items.flatMap((item) => {
      const release = normalizePlayerRelease(item);
      return release === undefined ? [] : [release];
    }),
  };
}

export function checkPlayerReleases(csrfToken: string) {
  return apiPost("/api/v1/player-releases/check", { csrfToken });
}

export function configureGitHubReleases(clientId: string, csrfToken: string) {
  return apiPost("/api/v1/player-releases/github/configuration", {
    body: { clientId },
    csrfToken,
  });
}

export function startGitHubDeviceAuthorization(csrfToken: string) {
  return apiPost("/api/v1/player-releases/github/device", { csrfToken });
}

export function pollGitHubDeviceAuthorization(
  flowId: string,
  csrfToken: string,
) {
  return apiPost("/api/v1/player-releases/github/device/poll", {
    body: { flowId },
    csrfToken,
  });
}

export function disconnectGitHub(csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/player-releases/github", { csrfToken });
}

export function cachePlayerRelease(id: string, csrfToken: string) {
  return apiPost("/api/v1/player-releases/{id}/cache", {
    params: { path: { id } },
    csrfToken,
  });
}

export function deletePlayerRelease(id: string, csrfToken: string) {
  return apiDelete("/api/v1/player-releases/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

/** Wire shapes of update deployments; unset values arrive as explicit null. */
export type WireUpdateDeploymentSummary =
  components["schemas"]["UpdateDeploymentSummary"];
export type WireUpdateDeploymentDetail =
  components["schemas"]["UpdateDeploymentDetail"];

export function normalizeUpdateDeployment(
  wire: WireUpdateDeploymentSummary,
): UpdateDeployment | undefined {
  const platform = normalizePlayerPlatform(wire.platform);
  if (platform === undefined) return undefined;
  return {
    ...wire,
    platform,
    playerFamily: normalizePlayerFamily(wire.playerFamily),
    pauseReason: wire.pauseReason ?? undefined,
    lastFailure: wire.lastFailure ?? undefined,
  };
}

export function normalizeUpdateDeploymentDetail(
  wire: WireUpdateDeploymentDetail,
): UpdateDeploymentDetail | undefined {
  const platform = normalizePlayerPlatform(wire.platform);
  if (platform === undefined) return undefined;
  return {
    ...wire,
    platform,
    playerFamily: normalizePlayerFamily(wire.playerFamily),
    completedAt: wire.completedAt ?? undefined,
    pauseReason: wire.pauseReason ?? undefined,
    screens: wire.screens.map((screen) => ({
      ...screen,
      permissionStatus: screen.permissionStatus ?? undefined,
      installerStatus: screen.installerStatus ?? undefined,
      safeError: screen.safeError ?? undefined,
      downloadStartedAt: screen.downloadStartedAt ?? undefined,
      downloadedAt: screen.downloadedAt ?? undefined,
      installStartedAt: screen.installStartedAt ?? undefined,
      completedAt: screen.completedAt ?? undefined,
    })),
  };
}

export async function listUpdateDeployments(): Promise<{
  items: UpdateDeployment[];
}> {
  const result = await apiGet("/api/v1/update-deployments");
  return {
    ...result,
    items: result.items.flatMap((item) => {
      const deployment = normalizeUpdateDeployment(item);
      return deployment === undefined ? [] : [deployment];
    }),
  };
}

export async function getUpdateDeployment(
  id: string,
): Promise<UpdateDeploymentDetail> {
  const detail = normalizeUpdateDeploymentDetail(
    await apiGet("/api/v1/update-deployments/{id}", {
      params: { path: { id } },
    }),
  );
  if (detail === undefined) {
    throw new ApiError(
      "This deployment's player family is not supported by this Studio version.",
      422,
      "unknown_player_family",
    );
  }
  return detail;
}

export function createUpdateDeployment(
  input: {
    releaseId: string;
    name: string;
    mode: UpdateDeploymentMode;
    screenIds: string[];
    groupIds: string[];
    canarySize?: number;
    maintenanceWindowStart?: string;
  },
  csrfToken: string,
): Promise<{ id: string; targetCount: number }> {
  return apiPost("/api/v1/update-deployments", { body: input, csrfToken });
}

export function cancelUpdateDeployment(
  id: string,
  csrfToken: string,
): Promise<{ id: string; status: string }> {
  return apiPost("/api/v1/update-deployments/{id}/cancel", {
    params: { path: { id } },
    csrfToken,
  });
}

export function retryUpdateScreen(
  deploymentId: string,
  screenId: string,
  csrfToken: string,
): Promise<{ state: string }> {
  return apiPost("/api/v1/update-deployments/{id}/screens/{screenId}/retry", {
    params: { path: { id: deploymentId, screenId } },
    csrfToken,
  });
}

export type WireTakeover = components["schemas"]["Takeover"];

export function normalizeTakeover(wire: WireTakeover): Takeover {
  return {
    ...wire,
    activatedAt: wire.activatedAt ?? undefined,
    cancelledAt: wire.cancelledAt ?? undefined,
  };
}

export function listTakeovers(): Promise<{
  items: Takeover[];
  total: number;
}> {
  return apiGet("/api/v1/takeovers").then((result) => ({
    ...result,
    items: result.items.map(normalizeTakeover),
  }));
}

export function activateTakeover(
  input: {
    name: string;
    description: string;
    playlistId: string;
    screenIds: string[];
    groupIds: string[];
    expiresAt: string;
    password?: string;
  },
  csrfToken: string,
): Promise<{
  id: string;
  status: string;
  affectedCount: number;
  expiresAt: string;
}> {
  return apiPost("/api/v1/takeovers", { body: input, csrfToken });
}

export function cancelTakeover(
  id: string,
  reason: string,
  csrfToken: string,
): Promise<{ id: string; status: string }> {
  return apiPost("/api/v1/takeovers/{id}/cancel", {
    params: { path: { id } },
    body: { reason },
    csrfToken,
  });
}

export function getSettings(options?: {
  signal?: AbortSignal;
}): Promise<SettingsDocument> {
  return apiGet("/api/v1/settings", options);
}

export function updateSettings(
  revision: number,
  values: Record<string, unknown>,
  csrfToken: string,
): Promise<SettingsDocument> {
  return apiPatch("/api/v1/settings", {
    body: { revision, values },
    csrfToken,
  });
}

export function resetSettings(
  revision: number,
  category: string,
  csrfToken: string,
): Promise<SettingsDocument> {
  return apiPost("/api/v1/settings/reset", {
    body: { revision, category },
    csrfToken,
  });
}

export async function listUsers(): Promise<{
  items: ManagedUser[];
  total: number;
}> {
  const wire = await apiGet("/api/v1/users");
  return {
    // Never-logged-in rows serialize lastLoginAt as null; Studio models
    // an absent timestamp as undefined.
    items: wire.items.map((item) => ({
      ...item,
      lastLoginAt: item.lastLoginAt ?? undefined,
    })),
    total: wire.total,
  };
}

export function createUser(
  input: {
    name: string;
    username: string;
    password: string;
    role: User["role"];
    active?: boolean;
  },
  csrfToken: string,
) {
  return apiPost("/api/v1/users", { body: input, csrfToken });
}

export function updateUser(
  id: string,
  input: {
    name?: string;
    username?: string;
    password?: string;
    role?: User["role"];
    active?: boolean;
  },
  csrfToken: string,
) {
  return apiPatch("/api/v1/users/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deactivateUser(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/users/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function permanentlyDeleteUser(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/users/{id}/permanent", {
    params: { path: { id } },
    csrfToken,
  });
}

export function getPreferences(options?: {
  signal?: AbortSignal;
}): Promise<SettingsDocument> {
  return apiGet("/api/v1/me/preferences", options);
}

export function updatePreferences(
  revision: number,
  values: Record<string, unknown>,
  csrfToken: string,
): Promise<SettingsDocument> {
  return apiPatch("/api/v1/me/preferences", {
    body: { revision, values },
    csrfToken,
  });
}

export function listIntegrationTokens(): Promise<IntegrationToken[]> {
  return apiGet("/api/v1/integration-tokens");
}

export function createIntegrationToken(
  body: {
    name: string;
    scopes: IntegrationScope[];
    dataSourceIds?: string[];
    expiresAt?: string;
  },
  csrfToken: string,
): Promise<IntegrationTokenCreated> {
  return apiPost("/api/v1/integration-tokens", { body, csrfToken });
}

export function revokeIntegrationToken(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/integration-tokens/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function previewBulkOperation(
  body: BulkOperationRequest,
): Promise<BulkPreview> {
  return apiPost("/api/v1/screens/bulk/preview", { body });
}

export function applyBulkOperation(
  body: BulkOperationRequest & { expectedChangeCount: number },
  csrfToken: string,
): Promise<BulkOperation> {
  return apiPost("/api/v1/screens/bulk/apply", { body, csrfToken });
}

export function undoBulkOperation(
  id: string,
  csrfToken: string,
): Promise<BulkOperation> {
  return apiPost("/api/v1/screens/bulk/operations/{id}/undo", {
    params: { path: { id } },
    csrfToken,
  });
}

export function getNotificationStatus(): Promise<NotificationStatus> {
  return apiGet("/api/v1/notifications/status");
}

export function listNotificationDeliveries(
  limit = 50,
): Promise<NotificationDelivery[]> {
  return apiGet("/api/v1/notifications/deliveries", {
    params: { query: { limit } },
  });
}

export function sendTestNotification(
  csrfToken: string,
): Promise<{ sentTo: string }> {
  return apiPost("/api/v1/notifications/test", { csrfToken });
}

export function listNotificationWebhooks(): Promise<NotificationWebhook[]> {
  return apiGet("/api/v1/notifications/webhooks");
}

export function createNotificationWebhook(
  body: {
    name: string;
    url: string;
    categories: NotificationCategory[];
  },
  csrfToken: string,
): Promise<NotificationWebhookCreated> {
  return apiPost("/api/v1/notifications/webhooks", { body, csrfToken });
}

export function updateNotificationWebhook(
  id: string,
  body: {
    name: string;
    url: string;
    enabled: boolean;
    categories: NotificationCategory[];
  },
  csrfToken: string,
): Promise<NotificationWebhook> {
  return apiPut("/api/v1/notifications/webhooks/{id}", {
    params: { path: { id } },
    body,
    csrfToken,
  });
}

export function deleteNotificationWebhook(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/notifications/webhooks/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function testNotificationWebhook(
  id: string,
  csrfToken: string,
): Promise<{ delivered: boolean }> {
  return apiPost("/api/v1/notifications/webhooks/{id}/test", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listBackups(): Promise<BackupList> {
  return apiGet("/api/v1/system/backups");
}

export function createBackup(csrfToken: string): Promise<BackupJob> {
  return apiPost("/api/v1/system/backups", { csrfToken });
}

export function verifyBackup(
  id: string,
  csrfToken: string,
): Promise<BackupJob> {
  return apiPost("/api/v1/system/backups/{id}/verify", {
    params: { path: { id } },
    csrfToken,
  });
}

export function getBackupRestorePlan(id: string): Promise<BackupRestorePlan> {
  return apiGet("/api/v1/system/backups/{id}/plan", {
    params: { path: { id } },
  });
}

export function restoreBackup(
  id: string,
  confirmIdentityMismatch: boolean,
  csrfToken: string,
): Promise<BackupJob> {
  return apiPost("/api/v1/system/backups/{id}/restore", {
    params: { path: { id } },
    body: { confirmIdentityMismatch },
    csrfToken,
  });
}

export function deleteBackup(
  id: string,
  force: boolean,
  csrfToken: string,
): Promise<{ deleted: boolean }> {
  return apiDelete("/api/v1/system/backups/{id}", {
    params: { path: { id }, query: force ? { force: true } : {} },
    csrfToken,
  });
}

export function runMaintenance(
  action: MaintenanceAction,
  csrfToken: string,
): Promise<{ action: string; status: string }> {
  return apiPost("/api/v1/system/maintenance/{action}", {
    params: { path: { action } },
    csrfToken,
  });
}

/** Wire shape of the settings export from the generated contract. */
export type WireSettingsExport = components["schemas"]["SettingsExport"];

/**
 * The export strips definitions; the Studio view always carries them,
 * so bridge the gap with an empty list. The server ignores definitions
 * on import, which only validates values.
 */
export function normalizeSettingsExport(
  wire: WireSettingsExport | null | undefined,
): SettingsExportDocument {
  const source = wire ?? ({} as WireSettingsExport);
  return {
    ...source,
    organization: {
      ...source.organization,
      definitions: [],
    },
  };
}

export function exportSettings(): Promise<SettingsExportDocument> {
  return apiGet("/api/v1/system/settings/export").then(normalizeSettingsExport);
}

/**
 * A parsed settings file is only an export document when it carries the
 * versioned envelope. Anything else fails import validation server-side;
 * reject it at the boundary with a readable error instead.
 */
export function isSettingsExportDocument(
  value: unknown,
): value is SettingsExportDocument {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["schemaVersion"] === 1 &&
    typeof record["exportedAt"] === "string" &&
    typeof record["tilecastVersion"] === "string" &&
    typeof record["organization"] === "object" &&
    record["organization"] !== null &&
    Array.isArray(record["groupPolicies"])
  );
}

export function previewSettingsImport(
  document: SettingsExportDocument,
  csrfToken: string,
): Promise<{
  valid: boolean;
  changedKeys: string[];
  groupPolicyCount: number;
  screenPolicyCount: number;
  requiresConfirmation: boolean;
}> {
  return apiPost("/api/v1/system/settings/import/preview", {
    body: document,
    csrfToken,
  });
}

export function applySettingsImport(
  document: SettingsExportDocument,
  csrfToken: string,
): Promise<SettingsDocument> {
  return apiPost("/api/v1/system/settings/import/apply", {
    body: document,
    csrfToken,
  });
}

export function getSystemStatus(): Promise<SystemStatus> {
  return apiGet("/api/v1/system/status");
}

/** Wire shape of the content health report from the generated contract. */
export type WireContentHealthReport =
  components["schemas"]["ContentHealthReport"];

export async function getContentHealth(): Promise<ContentHealthReport> {
  return normalizeContentHealthReport(await apiGet("/api/v1/content-health"));
}

/**
 * The health thresholds ride the wire with untagged Go-cased keys
 * (see contenthealth Thresholds); the Studio view reads camelCase.
 * Before this bridge the tab rendered undefined threshold counts.
 */
export function normalizeContentHealthReport(
  report: WireContentHealthReport | null | undefined,
): ContentHealthReport {
  const source = report ?? ({} as WireContentHealthReport);
  const thresholds = source.thresholds ?? {};
  return {
    ...source,
    staleSources: Array.isArray(source.staleSources) ? source.staleSources : [],
    expiringAssets: Array.isArray(source.expiringAssets)
      ? source.expiringAssets
      : [],
    emptyPlaylists: Array.isArray(source.emptyPlaylists)
      ? source.emptyPlaylists
      : [],
    unassignedScreens: Array.isArray(source.unassignedScreens)
      ? source.unassignedScreens
      : [],
    thresholds: {
      staleSourceHours: thresholds.StaleSourceHours ?? 0,
      expiringMediaDays: thresholds.ExpiringMediaDays ?? 0,
    },
  };
}

export function getFleetUptime(window: UptimeWindow): Promise<UptimeReport> {
  return apiGet("/api/v1/activity/uptime", {
    params: { query: { window } },
  });
}
