/**
 * System administration domain helpers over the typed transport: player
 * releases, update deployments, takeovers, settings, users, preferences,
 * integration tokens, notifications, backups, and maintenance. Player
 * release, GitHub device-flow, settings, and preference success bodies
 * are contract-typed and inferred from the generated schemas; the
 * remaining areas still state their local Studio response type
 * explicitly until the contract gains schemas. Binary release uploads
 * stay on XHR in ../client.ts: upload progress is an explicitly
 * exceptional transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type { components } from "@tilecast/api-schema/generated/openapi";
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
  SettingsDocument,
  SettingsExportDocument,
  SystemStatus,
  Takeover,
  UpdateDeployment,
  UpdateDeploymentDetail,
  UpdateDeploymentMode,
  UptimeReport,
  UptimeWindow,
  User,
} from "../types";

export function listPlayerReleases() {
  return apiGet("/api/v1/player-releases");
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

export function listUpdateDeployments(): Promise<{
  items: UpdateDeployment[];
}> {
  return apiGet<"/api/v1/update-deployments", { items: UpdateDeployment[] }>(
    "/api/v1/update-deployments",
  );
}

export function getUpdateDeployment(
  id: string,
): Promise<UpdateDeploymentDetail> {
  return apiGet<"/api/v1/update-deployments/{id}", UpdateDeploymentDetail>(
    "/api/v1/update-deployments/{id}",
    { params: { path: { id } } },
  );
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
  return apiPost<
    "/api/v1/update-deployments",
    { id: string; targetCount: number }
  >("/api/v1/update-deployments", { body: input, csrfToken });
}

export function cancelUpdateDeployment(
  id: string,
  csrfToken: string,
): Promise<{ id: string; status: string }> {
  return apiPost<
    "/api/v1/update-deployments/{id}/cancel",
    { id: string; status: string }
  >("/api/v1/update-deployments/{id}/cancel", {
    params: { path: { id } },
    csrfToken,
  });
}

export function retryUpdateScreen(
  deploymentId: string,
  screenId: string,
  csrfToken: string,
): Promise<{ state: string }> {
  return apiPost<
    "/api/v1/update-deployments/{id}/screens/{screenId}/retry",
    { state: string }
  >("/api/v1/update-deployments/{id}/screens/{screenId}/retry", {
    params: { path: { id: deploymentId, screenId } },
    csrfToken,
  });
}

export function listTakeovers(): Promise<{
  items: Takeover[];
  total: number;
}> {
  return apiGet<"/api/v1/takeovers", { items: Takeover[]; total: number }>(
    "/api/v1/takeovers",
  );
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
  return apiPost<
    "/api/v1/takeovers",
    { id: string; status: string; affectedCount: number; expiresAt: string }
  >("/api/v1/takeovers", { body: input, csrfToken });
}

export function cancelTakeover(
  id: string,
  reason: string,
  csrfToken: string,
): Promise<{ id: string; status: string }> {
  return apiPost<
    "/api/v1/takeovers/{id}/cancel",
    { id: string; status: string }
  >("/api/v1/takeovers/{id}/cancel", {
    params: { path: { id } },
    body: { reason },
    csrfToken,
  });
}

export function getSettings(): Promise<SettingsDocument> {
  return apiGet("/api/v1/settings");
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

export function getPreferences(): Promise<SettingsDocument> {
  return apiGet("/api/v1/me/preferences");
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
  return apiGet<"/api/v1/integration-tokens", IntegrationToken[]>(
    "/api/v1/integration-tokens",
  );
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
  return apiPost<"/api/v1/integration-tokens", IntegrationTokenCreated>(
    "/api/v1/integration-tokens",
    { body, csrfToken },
  );
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
  return apiPost<"/api/v1/screens/bulk/preview", BulkPreview>(
    "/api/v1/screens/bulk/preview",
    { body },
  );
}

export function applyBulkOperation(
  body: BulkOperationRequest & { expectedChangeCount: number },
  csrfToken: string,
): Promise<BulkOperation> {
  return apiPost<"/api/v1/screens/bulk/apply", BulkOperation>(
    "/api/v1/screens/bulk/apply",
    { body, csrfToken },
  );
}

export function undoBulkOperation(
  id: string,
  csrfToken: string,
): Promise<BulkOperation> {
  return apiPost<"/api/v1/screens/bulk/operations/{id}/undo", BulkOperation>(
    "/api/v1/screens/bulk/operations/{id}/undo",
    { params: { path: { id } }, csrfToken },
  );
}

export function getNotificationStatus(): Promise<NotificationStatus> {
  return apiGet<"/api/v1/notifications/status", NotificationStatus>(
    "/api/v1/notifications/status",
  );
}

export function listNotificationDeliveries(
  limit = 50,
): Promise<NotificationDelivery[]> {
  return apiGet<"/api/v1/notifications/deliveries", NotificationDelivery[]>(
    "/api/v1/notifications/deliveries",
    { params: { query: { limit } } },
  );
}

export function sendTestNotification(
  csrfToken: string,
): Promise<{ sentTo: string }> {
  return apiPost<"/api/v1/notifications/test", { sentTo: string }>(
    "/api/v1/notifications/test",
    { csrfToken },
  );
}

export function listNotificationWebhooks(): Promise<NotificationWebhook[]> {
  return apiGet<"/api/v1/notifications/webhooks", NotificationWebhook[]>(
    "/api/v1/notifications/webhooks",
  );
}

export function createNotificationWebhook(
  body: {
    name: string;
    url: string;
    categories: NotificationCategory[];
  },
  csrfToken: string,
): Promise<NotificationWebhookCreated> {
  return apiPost<"/api/v1/notifications/webhooks", NotificationWebhookCreated>(
    "/api/v1/notifications/webhooks",
    { body, csrfToken },
  );
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
  return apiPut<"/api/v1/notifications/webhooks/{id}", NotificationWebhook>(
    "/api/v1/notifications/webhooks/{id}",
    { params: { path: { id } }, body, csrfToken },
  );
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
  return apiPost<
    "/api/v1/notifications/webhooks/{id}/test",
    { delivered: boolean }
  >("/api/v1/notifications/webhooks/{id}/test", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listBackups(): Promise<BackupList> {
  return apiGet<"/api/v1/system/backups", BackupList>("/api/v1/system/backups");
}

export function createBackup(csrfToken: string): Promise<BackupJob> {
  return apiPost<"/api/v1/system/backups", BackupJob>(
    "/api/v1/system/backups",
    {
      csrfToken,
    },
  );
}

export function verifyBackup(
  id: string,
  csrfToken: string,
): Promise<BackupJob> {
  return apiPost<"/api/v1/system/backups/{id}/verify", BackupJob>(
    "/api/v1/system/backups/{id}/verify",
    { params: { path: { id } }, csrfToken },
  );
}

export function getBackupRestorePlan(id: string): Promise<BackupRestorePlan> {
  return apiGet<"/api/v1/system/backups/{id}/plan", BackupRestorePlan>(
    "/api/v1/system/backups/{id}/plan",
    { params: { path: { id } } },
  );
}

export function restoreBackup(
  id: string,
  confirmIdentityMismatch: boolean,
  csrfToken: string,
): Promise<BackupJob> {
  return apiPost<"/api/v1/system/backups/{id}/restore", BackupJob>(
    "/api/v1/system/backups/{id}/restore",
    { params: { path: { id } }, body: { confirmIdentityMismatch }, csrfToken },
  );
}

export function deleteBackup(
  id: string,
  force: boolean,
  csrfToken: string,
): Promise<{ deleted: boolean }> {
  return apiDelete<"/api/v1/system/backups/{id}", { deleted: boolean }>(
    "/api/v1/system/backups/{id}",
    {
      params: { path: { id }, query: force ? { force: true } : {} },
      csrfToken,
    },
  );
}

export function runMaintenance(
  action: MaintenanceAction,
  csrfToken: string,
): Promise<{ action: string; status: string }> {
  return apiPost<
    "/api/v1/system/maintenance/{action}",
    { action: string; status: string }
  >("/api/v1/system/maintenance/{action}", {
    params: { path: { action } },
    csrfToken,
  });
}

export function exportSettings(): Promise<SettingsExportDocument> {
  return apiGet<"/api/v1/system/settings/export", SettingsExportDocument>(
    "/api/v1/system/settings/export",
  );
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
  return apiPost<
    "/api/v1/system/settings/import/preview",
    {
      valid: boolean;
      changedKeys: string[];
      groupPolicyCount: number;
      screenPolicyCount: number;
      requiresConfirmation: boolean;
    }
  >("/api/v1/system/settings/import/preview", { body: document, csrfToken });
}

export function applySettingsImport(
  document: SettingsExportDocument,
  csrfToken: string,
): Promise<SettingsDocument> {
  return apiPost<"/api/v1/system/settings/import/apply", SettingsDocument>(
    "/api/v1/system/settings/import/apply",
    { body: document, csrfToken },
  );
}

export function getSystemStatus(): Promise<SystemStatus> {
  return apiGet<"/api/v1/system/status", SystemStatus>("/api/v1/system/status");
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
  return apiGet<"/api/v1/activity/uptime", UptimeReport>(
    "/api/v1/activity/uptime",
    { params: { query: { window } } },
  );
}
