import type {
  CreateFormInput,
  FormDataSource,
  FormMetadataInput,
  FormRevision,
  FormSchema,
  FormSummary,
  FormRecord,
  FormRecordPage,
  FormRecordDetail,
  FormRecordComment,
  FormRecordInput,
  FormRecordListParams,
  FormApprovalPage,
  FormWorkflow,
  FormView,
  FormViewInput,
  FormTypedDataset,
  FormOutputs,
  FormAccessEntry,
  FormDirectoryUser,
  AuthStatus,
  LoginInput,
  LoginResult,
  SessionResult,
  SecurityStatus,
  TOTPEnrollment,
  PasskeyCeremony,
  Passkey,
  PairingRequest,
  PlayerHistory,
  Location,
  LocationInput,
  PresentationNetwork,
  PresentationNetworkAssignment,
  PresentationNetworkDetail,
  PresentationNetworkInput,
  PresentationNetworkList,
  PresentationNetworkReadiness,
  PresentationNetworkTestResult,
  Screen,
  SetupInput,
  User,
  Asset,
  AssetList,
  UploadSession,
  Playlist,
  Campaign,
  CampaignList,
  CampaignPreflight,
  CampaignRelease,
  CampaignSnapshot,
  ContentSubmission,
  ContentSubmissionList,
  EditorialContentType,
  PublicationHistoryItem,
  PlaylistAssignment,
  PlaylistItemInput,
  PlaylistBulkItemUpdateInput,
  PlaylistList,
  ScreenGroup,
  ScreenGroupList,
  SpanStatus,
  DisplayControlGroupApplyResult,
  DisplayControlGroupPreview,
  Schedule,
  ScheduleInput,
  ScheduleList,
  SchedulePreview,
  WebsiteInput,
  WebsiteDiagnostics,
  WidgetInput,
  DataSourceDetail,
  DataSourceInput,
  DataSourceListResult,
  PlayerCommand,
  Takeover,
  PresentationOverride,
  NWSAlertMonitor,
  NWSAlertRule,
  NWSAlertRuleInput,
  NWSAlertSettings,
  NWSZone,
  SettingsDocument,
  PolicyDocument,
  EffectivePolicy,
  SystemStatus,
  ContentHealthReport,
  PlaylistRestoreResult,
  PlaylistRevisionList,
  ScreenSnapshotList,
  ContentReviewQueue,
  ScreenScope,
  ScreenScopes,
  IntegrationScope,
  IntegrationToken,
  IntegrationTokenCreated,
  BulkOperation,
  BulkOperationRequest,
  BulkPreview,
  NotificationCategory,
  NotificationDelivery,
  NotificationStatus,
  NotificationWebhook,
  NotificationWebhookCreated,
  PlayerReleaseList,
  PlayerReleaseImport,
  GitHubDeviceStart,
  GitHubDevicePoll,
  UpdateDeployment,
  UpdateDeploymentDetail,
  UptimeReport,
  UptimeWindow,
  ReliabilityStatus,
  AirplaySession,
  PowerAssistResults,
  CalendarConfig,
  CalendarPreview,
  DataSourceProvider,
  SourceRefreshDiagnostics,
  ContentFolder,
  ContentCollection,
  ContentTag,
  BulkOrganizeInput,
  StructuredSourceConfig,
  StructuredPreview,
  StructuredInspection,
  ManualSourceConfig,
  WeatherSourceConfig,
  TypedRecordData,
  TypedDatasetPayload,
  TransitSourceConfig,
  CAPAlertsSourceConfig,
  AirQualitySourceConfig,
  Layout,
  LayoutDocument,
  LayoutList,
  LayoutRevision,
  LayoutRevisionList,
  ProviderCatalog,
  ContentDefinitionCatalog,
  WidgetPresentation,
  BackupList,
  BackupJob,
  BackupRestorePlan,
  PluginCatalog,
  PluginSummary,
  DependencyGraph,
} from "./types";

type DataResponse<T> = { data: T };
type ErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

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

function normalizeScreenGroup(group: ScreenGroup): ScreenGroup {
  return {
    ...group,
    displayMode: group.displayMode === "span" ? "span" : "mirror",
    screens: Array.isArray(group.screens) ? group.screens : [],
  };
}

export function normalizeScreen(screen: Screen | null | undefined): Screen {
  const source = screen ?? ({} as Screen);
  return {
    ...source,
    deviceManufacturer:
      typeof source.deviceManufacturer === "string"
        ? source.deviceManufacturer
        : "",
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

export function normalizeProviderCatalog(
  catalog: ProviderCatalog | null | undefined,
): ProviderCatalog {
  const source = catalog ?? ({} as ProviderCatalog);
  return {
    ...source,
    providers: Array.isArray(source.providers) ? source.providers : [],
  };
}

export function normalizeContentDefinitionCatalog(
  catalog: ContentDefinitionCatalog | null | undefined,
): ContentDefinitionCatalog {
  const source = catalog ?? ({} as ContentDefinitionCatalog);
  return {
    ...source,
    widgets: Array.isArray(source.widgets) ? source.widgets : [],
    dataSources: Array.isArray(source.dataSources) ? source.dataSources : [],
  };
}

export function normalizePlaylist(
  playlist: Playlist | null | undefined,
): Playlist {
  const source = playlist ?? ({} as Playlist);
  return {
    ...source,
    items: Array.isArray(source.items) ? source.items : [],
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    layoutUsage: Array.isArray(source.layoutUsage) ? source.layoutUsage : [],
    hasUnpublishedChanges: Boolean(source.hasUnpublishedChanges),
  };
}

function normalizeLayoutDocument(
  document: LayoutDocument | null | undefined,
  layout: Pick<Layout, "orientation" | "canvasWidth" | "canvasHeight">,
): LayoutDocument {
  const fallback: LayoutDocument = {
    schemaVersion: 2,
    canvas: {
      width: layout.canvasWidth,
      height: layout.canvasHeight,
      orientation: layout.orientation,
      backgroundColor: "#0E141B",
      safeAreaPercent: 5,
    },
    placements: [],
  };
  if (!document) return fallback;
  return {
    ...document,
    schemaVersion: document.schemaVersion ?? fallback.schemaVersion,
    canvas: { ...fallback.canvas, ...(document.canvas ?? {}) },
    placements: Array.isArray(document.placements) ? document.placements : [],
  };
}

export function normalizeLayout(layout: Layout | null | undefined): Layout {
  const source = layout ?? ({} as Layout);
  return {
    ...source,
    draft: normalizeLayoutDocument(source.draft, source),
    dependencies: Array.isArray(source.dependencies) ? source.dependencies : [],
    usage: {
      screens: Array.isArray(source.usage?.screens) ? source.usage.screens : [],
      schedules: Array.isArray(source.usage?.schedules)
        ? source.usage.schedules
        : [],
      campaigns: Array.isArray(source.usage?.campaigns)
        ? source.usage.campaigns
        : [],
    },
  };
}

function normalizePlaylistList(
  result: PlaylistList | null | undefined,
): PlaylistList {
  const source = result ?? ({} as PlaylistList);
  return {
    ...source,
    items: (Array.isArray(source.items) ? source.items : []).map(
      normalizePlaylist,
    ),
  };
}

function normalizeLayoutList(
  result: LayoutList | null | undefined,
): LayoutList {
  const source = result ?? ({} as LayoutList);
  return {
    ...source,
    items: Array.isArray(source.items) ? source.items : [],
  };
}

async function requestPlaylist(path: string, init?: RequestInit) {
  return normalizePlaylist(await request<Playlist>(path, init));
}

async function requestLayout(path: string, init?: RequestInit) {
  return normalizeLayout(await request<Layout>(path, init));
}

async function apiFailure(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as ErrorResponse;
  throw new ApiError(
    body.error?.message ?? "Tilecast could not complete the request.",
    response.status,
    body.error?.code ?? "unknown_error",
  );
}

// formRecordBody serializes a record create/update body honoring the server's tri-state contract:
// a field left `undefined` is omitted (preserve), `null` is sent as null (clear), and any other
// value is sent as-is (set).
function formRecordBody(input: FormRecordInput): string {
  const body: Record<string, unknown> = { values: input.values };
  if (input.displayTitle !== undefined) body.displayTitle = input.displayTitle;
  if (input.priority !== undefined) body.priority = input.priority;
  if (input.displayAt !== undefined) body.displayAt = input.displayAt;
  if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt;
  if (input.version !== undefined) body.version = input.version;
  return JSON.stringify(body);
}

// readFileAsBase64 returns the base64 payload of a File (without the data: URL prefix), for the
// JSON attachment upload endpoint.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(
        new ApiError(
          "Could not read the selected file.",
          0,
          "file_read_failed",
        ),
      );
    reader.readAsDataURL(file);
  });
}

// formRecordQuery builds the query string for the paginated records list.
function formRecordQuery(params: FormRecordListParams = {}): string {
  const query = new URLSearchParams();
  if (params.states && params.states.length > 0)
    query.set("states", params.states.join(","));
  if (params.search) query.set("search", params.search);
  if (params.sort) query.set("sort", params.sort);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
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
  providerCatalog: async () =>
    normalizeProviderCatalog(
      await request<ProviderCatalog | null>("/provider-catalog"),
    ),
  contentDefinitions: async () =>
    normalizeContentDefinitionCatalog(
      await request<ContentDefinitionCatalog | null>("/content-definitions"),
    ),
  compileWidgetPreview: (
    provider: WidgetInput["provider"],
    configuration: WidgetInput["configuration"],
    csrfToken: string,
  ) =>
    request<WidgetPresentation>("/widgets/compile-preview", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ provider, configuration }),
    }),
  uploadWidgetPreview: async (id: string, image: Blob, csrfToken: string) => {
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
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new ApiError(
        body.error?.message ?? "The Widget preview image could not be saved.",
        response.status,
        body.error?.code ?? "unknown_error",
      );
    }
  },
  layouts: async (search = "") => {
    const pageSize = 100;
    const result = normalizeLayoutList(
      await request<LayoutList | null>(
        `/layouts?${new URLSearchParams({ search, page: "1", pageSize: String(pageSize) })}`,
      ),
    );
    const pageCount = Math.ceil(result.total / pageSize);
    if (pageCount <= 1) return result;

    const remainingPages = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, index) =>
        request<LayoutList | null>(
          `/layouts?${new URLSearchParams({
            search,
            page: String(index + 2),
            pageSize: String(pageSize),
          })}`,
        ).then(normalizeLayoutList),
      ),
    );
    return {
      ...result,
      items: [result, ...remainingPages].flatMap((page) => page.items),
    };
  },
  layout: (id: string) => requestLayout(`/layouts/${id}`),
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
  createLayout: (
    input: {
      name: string;
      description: string;
      orientation: string;
      canvasWidth: number;
      canvasHeight: number;
    },
    csrfToken: string,
  ) =>
    requestLayout("/layouts", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateLayout: (
    id: string,
    input: { name: string; description: string },
    csrfToken: string,
  ) =>
    requestLayout(`/layouts/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  saveLayoutDraft: (
    id: string,
    expectedDraftRevision: number,
    document: LayoutDocument,
    csrfToken: string,
  ) =>
    requestLayout(`/layouts/${id}/draft`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision, document }),
    }),
  publishLayout: (
    id: string,
    expectedDraftRevision: number,
    csrfToken: string,
  ) =>
    request<LayoutRevision>(`/layouts/${id}/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision }),
    }),
  duplicateLayout: (id: string, csrfToken: string) =>
    requestLayout(`/layouts/${id}/duplicate`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  deleteLayout: (id: string, csrfToken: string) =>
    request<void>(`/layouts/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  layoutRevisions: (id: string) =>
    request<LayoutRevisionList>(`/layouts/${id}/revisions?page=1&pageSize=100`),
  restoreLayoutRevision: (
    id: string,
    revisionId: string,
    expectedDraftRevision: number,
    csrfToken: string,
  ) =>
    requestLayout(`/layouts/${id}/revisions/${revisionId}/restore`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision }),
    }),
  playerReleases: () => request<PlayerReleaseList>("/player-releases"),
  checkPlayerReleases: (csrfToken: string) =>
    request<{ checked: boolean }>("/player-releases/check", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  startGitHubDeviceAuthorization: (csrfToken: string) =>
    request<GitHubDeviceStart>("/player-releases/github/device", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  pollGitHubDeviceAuthorization: (flowId: string, csrfToken: string) =>
    request<GitHubDevicePoll>("/player-releases/github/device/poll", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ flowId }),
    }),
  disconnectGitHub: (csrfToken: string) =>
    request<void>("/player-releases/github", {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  cachePlayerRelease: (id: string, csrfToken: string) =>
    request<{ id: string; cacheStatus: string }>(
      `/player-releases/${id}/cache`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  deletePlayerRelease: (id: string, csrfToken: string) =>
    request<{ id: string; deleted: boolean }>(`/player-releases/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
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
  updateDeployments: () =>
    request<{ items: UpdateDeployment[] }>("/update-deployments"),
  updateDeployment: (id: string) =>
    request<UpdateDeploymentDetail>(`/update-deployments/${id}`),
  retryUpdateScreen: (
    deploymentId: string,
    screenId: string,
    csrfToken: string,
  ) =>
    request<{ state: string }>(
      `/update-deployments/${deploymentId}/screens/${screenId}/retry`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  createUpdateDeployment: (
    input: {
      releaseId: string;
      name: string;
      mode: string;
      screenIds: string[];
      groupIds: string[];
      canarySize?: number;
      maintenanceWindowStart?: string;
    },
    csrfToken: string,
  ) =>
    request<{ id: string; targetCount: number }>("/update-deployments", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  cancelUpdateDeployment: (id: string, csrfToken: string) =>
    request<{ id: string; status: string }>(
      `/update-deployments/${id}/cancel`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  settings: () => request<SettingsDocument>("/settings"),
  users: () => request<{ items: User[]; total: number }>("/users"),
  updateSettings: (
    revision: number,
    values: Record<string, unknown>,
    csrfToken: string,
  ) =>
    request<SettingsDocument>("/settings", {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ revision, values }),
    }),
  resetSettings: (revision: number, category: string, csrfToken: string) =>
    request<SettingsDocument>("/settings/reset", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ revision, category }),
    }),
  preferences: () => request<SettingsDocument>("/me/preferences"),
  updatePreferences: (
    revision: number,
    values: Record<string, unknown>,
    csrfToken: string,
  ) =>
    request<SettingsDocument>("/me/preferences", {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ revision, values }),
    }),
  groupPolicy: (id: string) =>
    request<PolicyDocument>(`/screen-groups/${id}/policy`),
  putGroupPolicy: (
    id: string,
    revision: number,
    priority: number,
    values: Record<string, unknown>,
    csrfToken: string,
  ) =>
    request<PolicyDocument>(`/screen-groups/${id}/policy`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ revision, priority, values }),
    }),
  deleteGroupPolicy: (id: string, csrfToken: string) =>
    request<void>(`/screen-groups/${id}/policy`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  screenPolicy: (id: string) =>
    request<PolicyDocument>(`/screens/${id}/policy`),
  putScreenPolicy: (
    id: string,
    revision: number,
    values: Record<string, unknown>,
    csrfToken: string,
  ) =>
    request<PolicyDocument>(`/screens/${id}/policy`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ revision, values }),
    }),
  deleteScreenPolicy: (id: string, csrfToken: string) =>
    request<void>(`/screens/${id}/policy`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  effectivePolicy: (id: string) =>
    request<EffectivePolicy>(`/screens/${id}/effective-policy`),
  systemStatus: () => request<SystemStatus>("/system/status"),
  contentHealth: () => request<ContentHealthReport>("/content-health"),
  screenSnapshots: (screenId: string, limit = 50) =>
    request<ScreenSnapshotList>(
      `/screens/${screenId}/snapshots?limit=${limit}`,
    ),
  playlistRevisions: (playlistId: string) =>
    request<PlaylistRevisionList>(`/playlists/${playlistId}/revisions`),
  restorePlaylistRevision: (
    playlistId: string,
    revision: number,
    csrfToken: string,
  ) =>
    request<PlaylistRestoreResult>(
      `/playlists/${playlistId}/revisions/${revision}/restore`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  publishPlaylist: (
    id: string,
    expectedDraftRevision: number,
    csrfToken: string,
  ) =>
    request<unknown>(`/playlists/${id}/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision }),
    }),
  contentReviews: (state = "") =>
    request<ContentReviewQueue>(
      `/content-reviews${state ? `?state=${state}` : ""}`,
    ),
  decideContentReview: (
    contentType: string,
    id: string,
    body: { approve: boolean; note?: string; revision?: number },
    csrfToken: string,
  ) =>
    request<unknown>(`/content-reviews/${contentType}/${id}`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }),
  contentSubmissions: (state = "") =>
    request<ContentSubmissionList>(
      `/content-submissions${state ? `?state=${encodeURIComponent(state)}` : ""}`,
    ),
  contentSubmission: (id: string) =>
    request<ContentSubmission>(`/content-submissions/${id}`),
  submitContent: (
    contentType: EditorialContentType,
    id: string,
    csrfToken: string,
    requestedPublicationAt?: string,
    expectedRevision?: number,
  ) =>
    request<ContentSubmission>(`/content-submissions/${contentType}/${id}`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ requestedPublicationAt, expectedRevision }),
    }),
  approveContentSubmission: (id: string, note: string, csrfToken: string) =>
    request<ContentSubmission>(`/content-submissions/${id}/approve`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ note }),
    }),
  requestContentChanges: (id: string, note: string, csrfToken: string) =>
    request<ContentSubmission>(`/content-submissions/${id}/request-changes`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ note }),
    }),
  publishContentSubmission: (
    id: string,
    csrfToken: string,
    method = "manual",
  ) =>
    request<unknown>(`/content-submissions/${id}/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ method }),
    }),
  scheduleContentSubmission: (
    id: string,
    requestedPublicationAt: string,
    csrfToken: string,
  ) =>
    request<ContentSubmission>(`/content-submissions/${id}/schedule`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ requestedPublicationAt }),
    }),
  cancelContentSchedule: (id: string, csrfToken: string) =>
    request<ContentSubmission>(`/content-submissions/${id}/cancel-schedule`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  publicationHistory: (contentType: EditorialContentType, id: string) =>
    request<{ items: PublicationHistoryItem[] }>(
      `/content-history/${contentType}/${id}/publications`,
    ),
  comparePublications: (
    contentType: EditorialContentType,
    id: string,
    fromPublicationId: string,
    toPublicationId: string,
  ) =>
    request<{
      changed: boolean;
      changes: { kind: string; path: string; description: string }[];
    }>(
      `/content-history/${contentType}/${id}/compare?fromPublicationId=${encodeURIComponent(fromPublicationId)}&toPublicationId=${encodeURIComponent(toPublicationId)}`,
    ),
  restorePublicationToDraft: (
    contentType: EditorialContentType,
    contentId: string,
    publicationId: string,
    csrfToken: string,
  ) =>
    request<unknown>(
      `/content-history/${contentType}/${contentId}/publications/${publicationId}/restore-draft`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  rollbackPublication: (
    contentType: EditorialContentType,
    contentId: string,
    publicationId: string,
    csrfToken: string,
  ) =>
    request<unknown>(
      `/content-history/${contentType}/${contentId}/publications/${publicationId}/rollback`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  campaigns: async (search = "") =>
    request<CampaignList>(
      `/campaigns?page=1&pageSize=100&search=${encodeURIComponent(search)}`,
    ),
  campaign: (id: string) => request<Campaign>(`/campaigns/${id}`),
  createCampaign: (
    input: { name: string; description?: string; timezone?: string },
    csrfToken: string,
  ) =>
    request<Campaign>("/campaigns", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateCampaignDraft: (
    id: string,
    expectedDraftRevision: number,
    draft: CampaignSnapshot,
    csrfToken: string,
  ) =>
    request<Campaign>(`/campaigns/${id}/draft`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision, draft }),
    }),
  campaignPreflight: (id: string) =>
    request<CampaignPreflight>(`/campaigns/${id}/preflight`),
  campaignReleases: (id: string) =>
    request<{ items: CampaignRelease[] }>(`/campaigns/${id}/releases`),
  restoreCampaignRelease: (id: string, releaseId: string, csrfToken: string) =>
    request<Campaign>(`/campaigns/${id}/releases/${releaseId}/restore`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  publishCampaign: (
    id: string,
    expectedDraftRevision: number,
    csrfToken: string,
  ) =>
    request<unknown>(`/campaigns/${id}/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ expectedDraftRevision }),
    }),
  archiveCampaign: (id: string, csrfToken: string) =>
    request<void>(`/campaigns/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
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
  integrationTokens: () => request<IntegrationToken[]>("/integration-tokens"),
  createIntegrationToken: (
    body: {
      name: string;
      scopes: IntegrationScope[];
      dataSourceIds?: string[];
      expiresAt?: string;
    },
    csrfToken: string,
  ) =>
    request<IntegrationTokenCreated>("/integration-tokens", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }),
  revokeIntegrationToken: (id: string, csrfToken: string) =>
    request<void>(`/integration-tokens/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  previewBulkOperation: (body: BulkOperationRequest) =>
    request<BulkPreview>("/screens/bulk/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  applyBulkOperation: (
    body: BulkOperationRequest & { expectedChangeCount: number },
    csrfToken: string,
  ) =>
    request<BulkOperation>("/screens/bulk/apply", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }),
  bulkOperations: (limit = 10) =>
    request<BulkOperation[]>(`/screens/bulk/operations?limit=${limit}`),
  undoBulkOperation: (id: string, csrfToken: string) =>
    request<BulkOperation>(`/screens/bulk/operations/${id}/undo`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  notificationStatus: () =>
    request<NotificationStatus>("/notifications/status"),
  notificationDeliveries: (limit = 50) =>
    request<NotificationDelivery[]>(`/notifications/deliveries?limit=${limit}`),
  sendTestNotification: (csrfToken: string) =>
    request<{ sentTo: string }>("/notifications/test", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  notificationWebhooks: () =>
    request<NotificationWebhook[]>("/notifications/webhooks"),
  createNotificationWebhook: (
    body: {
      name: string;
      url: string;
      categories: NotificationCategory[];
    },
    csrfToken: string,
  ) =>
    request<NotificationWebhookCreated>("/notifications/webhooks", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }),
  updateNotificationWebhook: (
    id: string,
    body: {
      name: string;
      url: string;
      enabled: boolean;
      categories: NotificationCategory[];
    },
    csrfToken: string,
  ) =>
    request<NotificationWebhook>(`/notifications/webhooks/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(body),
    }),
  deleteNotificationWebhook: (id: string, csrfToken: string) =>
    request<void>(`/notifications/webhooks/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  testNotificationWebhook: (id: string, csrfToken: string) =>
    request<{ delivered: boolean }>(`/notifications/webhooks/${id}/test`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  backups: () => request<BackupList>("/system/backups"),
  createBackup: (csrfToken: string) =>
    request<BackupJob>("/system/backups", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  verifyBackup: (id: string, csrfToken: string) =>
    request<BackupJob>(`/system/backups/${id}/verify`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  backupRestorePlan: (id: string) =>
    request<BackupRestorePlan>(`/system/backups/${id}/plan`),
  restoreBackup: (
    id: string,
    confirmIdentityMismatch: boolean,
    csrfToken: string,
  ) =>
    request<BackupJob>(`/system/backups/${id}/restore`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ confirmIdentityMismatch }),
    }),
  deleteBackup: (id: string, force: boolean, csrfToken: string) =>
    request<{ deleted: boolean }>(
      `/system/backups/${id}${force ? "?force=true" : ""}`,
      { method: "DELETE", headers: { "X-CSRF-Token": csrfToken } },
    ),
  runMaintenance: (action: string, csrfToken: string) =>
    request<{ action: string; status: string }>(
      `/system/maintenance/${action}`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  exportSettings: () =>
    request<Record<string, unknown>>("/system/settings/export"),
  previewSettingsImport: (document: unknown, csrfToken: string) =>
    request<{
      valid: boolean;
      changedKeys: string[];
      groupPolicyCount: number;
      screenPolicyCount: number;
      requiresConfirmation: boolean;
    }>("/system/settings/import/preview", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(document),
    }),
  applySettingsImport: (document: unknown, csrfToken: string) =>
    request<SettingsDocument>("/system/settings/import/apply", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(document),
    }),
  authStatus: () => request<AuthStatus>("/auth/status"),
  setup: (input: SetupInput) =>
    request<SessionResult>("/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  login: (input: LoginInput) =>
    request<LoginResult>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  verifyMfa: (challengeToken: string, code: string) =>
    request<SessionResult>("/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ challengeToken, code }),
    }),
  mfaPasskeyOptions: (challengeToken: string) =>
    request<PasskeyCeremony>("/auth/mfa/passkey/options", {
      method: "POST",
      body: JSON.stringify({ challengeToken }),
    }),
  passkeyLoginOptions: () =>
    request<PasskeyCeremony>("/auth/passkey/login/options", {
      method: "POST",
    }),
  passkeyLogin: (challengeToken: string, credential: unknown) =>
    request<SessionResult>("/auth/passkey/login", {
      method: "POST",
      headers: { "X-MFA-Challenge": challengeToken },
      body: JSON.stringify(credential),
    }),
  security: () => request<SecurityStatus>("/me/security"),
  beginTotpEnrollment: (csrfToken: string) =>
    request<TOTPEnrollment>("/me/security/totp", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  confirmTotpEnrollment: (code: string, csrfToken: string) =>
    request<SecurityStatus>("/me/security/totp/confirm", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ code }),
    }),
  removeTotp: (password: string, csrfToken: string) =>
    request<void>("/me/security/totp/remove", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ password }),
    }),
  regenerateRecoveryCodes: (password: string, csrfToken: string) =>
    request<{ codes: string[] }>("/me/security/recovery-codes", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ password }),
    }),
  passkeyRegistrationOptions: (csrfToken: string) =>
    request<PasskeyCeremony>("/me/security/passkeys/options", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  registerPasskey: (
    challengeToken: string,
    credential: unknown,
    csrfToken: string,
  ) =>
    request<Passkey>("/me/security/passkeys", {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfToken,
        "X-MFA-Challenge": challengeToken,
      },
      body: JSON.stringify(credential),
    }),
  renamePasskey: (id: string, name: string, csrfToken: string) =>
    request<void>(`/me/security/passkeys/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ name }),
    }),
  removePasskey: (id: string, password: string, csrfToken: string) =>
    request<void>(`/me/security/passkeys/${id}/remove`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ password }),
    }),
  resetUserSecurity: (id: string, csrfToken: string) =>
    request<void>(`/users/${id}/security/reset`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  logout: (csrfToken: string) =>
    request<void>("/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  screens: async () => {
    const result = await request<{
      items?: Screen[];
      total?: number;
    } | null>("/screens");
    return {
      ...(result ?? {}),
      items: (Array.isArray(result?.items) ? result.items : []).map(
        normalizeScreen,
      ),
      total: result?.total ?? 0,
    };
  },
  locations: () => request<{ items: Location[]; total: number }>("/locations"),
  presentationNetworks: () =>
    request<PresentationNetworkList>("/presentation-networks"),
  presentationNetwork: (id: string) =>
    request<PresentationNetworkDetail>(`/presentation-networks/${id}`),
  createPresentationNetwork: (
    input: PresentationNetworkInput,
    csrfToken: string,
  ) =>
    request<PresentationNetwork>("/presentation-networks", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updatePresentationNetwork: (
    id: string,
    input: PresentationNetworkInput,
    csrfToken: string,
  ) =>
    request<PresentationNetwork>(`/presentation-networks/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deletePresentationNetwork: (id: string, csrfToken: string) =>
    request<PresentationNetwork>(`/presentation-networks/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  replacePresentationNetworkAssignments: (
    id: string,
    screenIds: string[],
    csrfToken: string,
  ) =>
    request<{ assignments: PresentationNetworkAssignment[] }>(
      `/presentation-networks/${id}/screens`,
      {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ screenIds }),
      },
    ),
  screenPresentationNetwork: (id: string) =>
    request<PresentationNetworkReadiness>(
      `/screens/${id}/presentation-network`,
    ),
  assignScreenPresentationNetwork: (
    screenId: string,
    presentationNetworkId: string,
    csrfToken: string,
  ) =>
    request<PresentationNetworkAssignment>(
      `/screens/${screenId}/presentation-network`,
      {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ presentationNetworkId }),
      },
    ),
  unassignScreenPresentationNetwork: (screenId: string, csrfToken: string) =>
    request<PresentationNetworkAssignment>(
      `/screens/${screenId}/presentation-network`,
      {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfToken },
      },
    ),
  testPresentationNetwork: (id: string, screenId: string, csrfToken: string) =>
    request<PresentationNetworkTestResult>(
      `/presentation-networks/${id}/test`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ screenId }),
      },
    ),
  plugins: () => request<PluginCatalog>("/plugins"),
  installPlugin: (id: string, csrfToken: string) =>
    request<PluginSummary>(`/plugins/${encodeURIComponent(id)}/install`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  removePlugin: (id: string, csrfToken: string) =>
    request<void>(`/plugins/${encodeURIComponent(id)}/installation`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  dependencyGraph: () => request<DependencyGraph>("/plugins/dependency-graph"),
  createLocation: (input: LocationInput, csrfToken: string) =>
    request<Location>("/locations", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateLocation: (id: string, input: LocationInput, csrfToken: string) =>
    request<Location>(`/locations/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteLocation: (id: string, csrfToken: string) =>
    request<void>(`/locations/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  pendingPairings: () =>
    request<{ items: PairingRequest[]; total: number }>(
      "/screens/pairing/pending",
    ),
  screen: async (id: string) =>
    normalizeScreen(await request<Screen | null>(`/screens/${id}`)),
  screenReliability: (id: string) =>
    request<ReliabilityStatus>(`/screens/${id}/reliability`),
  screenPlayerHistory: async (id: string) => {
    const result = await request<{ items: PlayerHistory[]; total: number }>(
      `/screens/${id}/player-history`,
    );
    return {
      ...result,
      items: Array.isArray(result.items) ? result.items : [],
    };
  },
  airplaySession: (id: string) =>
    request<AirplaySession>(`/airplay/sessions/${id}`),
  createAirplaySession: (
    input: {
      targetType: "screen" | "group";
      targetId: string;
      durationMinutes: 0 | 15 | 30 | 60;
      transport: "auto" | "unicast" | "multicast";
      audioMode: "gateway_only" | "none";
    },
    csrfToken: string,
  ) =>
    request<AirplaySession>("/airplay/sessions", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  stopAirplaySession: (id: string, csrfToken: string, reason = "manual_stop") =>
    request<AirplaySession>(`/airplay/sessions/${id}/stop`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason }),
    }),
  presentationOverrides: () =>
    request<{ items: PresentationOverride[]; total: number }>(
      "/presentation-overrides",
    ),
  createPresentationOverride: (
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
  ) =>
    request<PresentationOverride>("/presentation-overrides", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  stopPresentationOverride: (id: string, csrfToken: string) =>
    request<PresentationOverride>(`/presentation-overrides/${id}/stop`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason: "Stopped from Tilecast Studio" }),
    }),
  fleetUptime: (window: UptimeWindow) =>
    request<UptimeReport>(`/activity/uptime?window=${window}`),
  confirmPowerAssist: (
    id: string,
    results: PowerAssistResults,
    csrfToken: string,
  ) =>
    request<{ screenId: string; lastTestedAt: string }>(
      `/screens/${id}/power-assist`,
      {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(results),
      },
    ),
  resolvePairing: (code: string) =>
    request<PairingRequest>("/screens/pairing/resolve", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  approvePairing: (
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
  ) =>
    request<Screen>(`/screens/pairing/${id}/approve`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  rejectPairing: (id: string, reason: string, csrfToken: string) =>
    request<void>(`/screens/pairing/${id}/reject`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason }),
    }),
  updateScreen: (
    id: string,
    input: {
      name: string;
      locationId?: string;
      roomName: string;
      roomNumber: string;
      description: string;
    },
    csrfToken: string,
  ) =>
    request<Screen>(`/screens/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  setScreenEnabled: (id: string, enabled: boolean, csrfToken: string) =>
    request<void>(`/screens/${id}/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  revokeScreen: (id: string, reason: string, csrfToken: string) =>
    request<void>(`/screens/${id}/revoke`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason }),
    }),
  screenCommands: (id: string) =>
    request<{ items: PlayerCommand[]; total: number }>(
      `/screens/${id}/commands`,
    ),
  createScreenCommand: (
    id: string,
    type: string,
    payload: Record<string, unknown>,
    csrfToken: string,
  ) =>
    request<{ id: string; state: string; expiresAt: string }>(
      `/screens/${id}/commands`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ type, payload }),
      },
    ),
  cancelScreenCommand: (
    screenId: string,
    commandId: string,
    csrfToken: string,
  ) =>
    request<{ id: string; state: string }>(
      `/screens/${screenId}/commands/${commandId}/cancel`,
      { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
    ),
  takeovers: () => request<{ items: Takeover[]; total: number }>("/takeovers"),
  activateTakeover: (
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
  ) =>
    request<{
      id: string;
      status: string;
      affectedCount: number;
      expiresAt: string;
    }>("/takeovers", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  cancelTakeover: (id: string, reason: string, csrfToken: string) =>
    request<{ id: string; status: string }>(`/takeovers/${id}/cancel`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason }),
    }),
  nwsAlertSettings: () => request<NWSAlertSettings>("/alerts/nws"),
  nwsZones: (area: string) =>
    request<{ items: NWSZone[] }>(
      `/alerts/nws/zones?area=${encodeURIComponent(area)}`,
    ),
  updateNWSAlertMonitor: (
    input: {
      enabled: boolean;
      areas: string[];
      zones: string[];
      pollIntervalSeconds: number;
    },
    csrfToken: string,
  ) =>
    request<NWSAlertMonitor>("/alerts/nws/monitor", {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  pollNWSAlerts: (csrfToken: string) =>
    request<NWSAlertSettings>("/alerts/nws/poll", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  createNWSAlertRule: (input: NWSAlertRuleInput, csrfToken: string) =>
    request<NWSAlertRule>("/alerts/nws/rules", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateNWSAlertRule: (
    id: string,
    input: NWSAlertRuleInput,
    csrfToken: string,
  ) =>
    request<NWSAlertRule>(`/alerts/nws/rules/${id}`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteNWSAlertRule: (id: string, csrfToken: string) =>
    request<{ id: string; deleted: boolean }>(`/alerts/nws/rules/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  assets: (params: URLSearchParams) =>
    request<AssetList>(`/assets?${params.toString()}`),
  contentFolders: () => request<ContentFolder[]>("/content-folders"),
  createContentFolder: (
    input: { name: string; description: string; parentId?: string },
    csrfToken: string,
  ) =>
    request<ContentFolder>("/content-folders", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateContentFolder: (
    id: string,
    input: { name: string; description: string; parentId?: string },
    csrfToken: string,
  ) =>
    request<ContentFolder>(`/content-folders/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteContentFolder: (id: string, csrfToken: string) =>
    request<void>(`/content-folders/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  contentCollections: () =>
    request<ContentCollection[]>("/content-collections"),
  createContentCollection: (
    input: { name: string; description: string },
    csrfToken: string,
  ) =>
    request<ContentCollection>("/content-collections", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateContentCollection: (
    id: string,
    input: { name: string; description: string },
    csrfToken: string,
  ) =>
    request<ContentCollection>(`/content-collections/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteContentCollection: (id: string, csrfToken: string) =>
    request<void>(`/content-collections/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  contentTags: () => request<ContentTag[]>("/content-tags"),
  createContentTag: (
    input: { name: string; color: string },
    csrfToken: string,
  ) =>
    request<ContentTag>("/content-tags", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateContentTag: (
    id: string,
    input: { name: string; color: string },
    csrfToken: string,
  ) =>
    request<ContentTag>(`/content-tags/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteContentTag: (id: string, csrfToken: string) =>
    request<void>(`/content-tags/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  bulkOrganize: (input: BulkOrganizeInput, csrfToken: string) =>
    request<{ updated: number }>("/assets/bulk-organize", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  archiveAssets: (assetIds: string[], csrfToken: string) =>
    request<{ updated: number }>("/assets/archive", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ assetIds }),
    }),
  restoreAssets: (assetIds: string[], csrfToken: string) =>
    request<{ updated: number }>("/assets/restore", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ assetIds }),
    }),
  asset: (id: string) => request<Asset>(`/assets/${id}`),
  assetPreviewUrl: (id: string) =>
    `/api/v1/assets/${encodeURIComponent(id)}/preview`,
  updateAsset: (
    id: string,
    input: {
      name?: string;
      description?: string;
      availabilitySet?: boolean;
      availableFrom?: string;
      expiresAt?: string;
    },
    csrfToken: string,
  ) =>
    request<Asset>(`/assets/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  setPlaylistTagRule: (
    id: string,
    input: {
      enabled: boolean;
      match: "any" | "all";
      imageDurationMs: number;
      tagIds: string[];
    },
    csrfToken: string,
  ) =>
    request<Playlist>(`/playlists/${id}/tag-rule`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  createWebsite: (input: WebsiteInput, csrfToken: string) =>
    request<Asset>("/assets/websites", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateWebsite: (id: string, input: WebsiteInput, csrfToken: string) =>
    request<Asset>(`/assets/${id}/website`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  websiteDiagnostics: (id: string) =>
    request<WebsiteDiagnostics>(`/assets/${id}/website/diagnostics`),
  createWidget: (input: WidgetInput, csrfToken: string) =>
    request<Asset>("/widgets", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateWidget: (id: string, input: WidgetInput, csrfToken: string) =>
    request<Asset>(`/widgets/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  duplicateWidget: (id: string, csrfToken: string) =>
    request<Asset>(`/widgets/${id}/duplicate`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  listDataSources: (params?: URLSearchParams) =>
    request<DataSourceListResult>(
      `/data-sources?${(
        params ?? new URLSearchParams({ page: "1", pageSize: "100" })
      ).toString()}`,
    ),
  getDataSource: (id: string) =>
    request<DataSourceDetail>(`/data-sources/${id}`),
  createDataSource: (input: DataSourceInput, csrfToken: string) =>
    request<DataSourceDetail>("/data-sources", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateDataSource: (id: string, input: DataSourceInput, csrfToken: string) =>
    request<DataSourceDetail>(`/data-sources/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  duplicateDataSource: (id: string, csrfToken: string) =>
    request<DataSourceDetail>(`/data-sources/${id}/duplicate`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  deleteDataSource: (id: string, csrfToken: string) =>
    request<void>(`/data-sources/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  // Form Data Sources. Creation is a dedicated endpoint; the detail, metadata, draft, and
  // publish operations are namespaced under the parent Data Source id.
  createForm: (input: CreateFormInput, csrfToken: string) =>
    request<FormDataSource>("/forms", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  getForm: (id: string) => request<FormDataSource>(`/data-sources/${id}/form`),
  updateFormMetadata: (
    id: string,
    input: FormMetadataInput,
    csrfToken: string,
  ) =>
    request<FormDataSource>(`/data-sources/${id}/form`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateFormDraft: (id: string, schema: FormSchema, csrfToken: string) =>
    request<FormDataSource>(`/data-sources/${id}/form/draft`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ schema }),
    }),
  publishForm: (id: string, csrfToken: string) =>
    request<FormRevision>(`/data-sources/${id}/form/publish`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  // Accessible forms for the Forms portal and navigation.
  listForms: () =>
    request<{ items: FormSummary[] }>("/forms").then((result) => result.items),
  // Records / submissions.
  listFormRecords: (id: string, params?: FormRecordListParams) =>
    request<FormRecordPage>(
      `/data-sources/${id}/records${formRecordQuery(params)}`,
    ),
  getFormRecord: (id: string, recordId: string) =>
    request<FormRecordDetail>(`/data-sources/${id}/records/${recordId}`),
  createFormRecord: (id: string, input: FormRecordInput, csrfToken: string) =>
    request<FormRecord>(`/data-sources/${id}/records`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: formRecordBody(input),
    }),
  updateFormRecord: (
    id: string,
    recordId: string,
    input: FormRecordInput,
    csrfToken: string,
  ) =>
    request<FormRecord>(`/data-sources/${id}/records/${recordId}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: formRecordBody(input),
    }),
  deleteFormRecord: (id: string, recordId: string, csrfToken: string) =>
    request<void>(`/data-sources/${id}/records/${recordId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  transitionFormRecord: (
    id: string,
    recordId: string,
    input: { toState: string; note?: string; version: number },
    csrfToken: string,
  ) =>
    request<FormRecord>(`/data-sources/${id}/records/${recordId}/transitions`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  addFormRecordComment: (
    id: string,
    recordId: string,
    body: string,
    csrfToken: string,
  ) =>
    request<FormRecordComment>(
      `/data-sources/${id}/records/${recordId}/comments`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ body }),
      },
    ),
  // Attachments. Upload/replace and remove return the updated record detail.
  // Attachment upload/removal use optimistic concurrency: the caller passes the record's current
  // version, and the returned detail carries the incremented version to use for the next action.
  uploadFormRecordAttachment: async (
    id: string,
    recordId: string,
    file: File,
    fieldKey: string,
    version: number,
    csrfToken: string,
  ) => {
    const data = await readFileAsBase64(file);
    return request<FormRecordDetail>(
      `/data-sources/${id}/records/${recordId}/attachments`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          fieldKey,
          fileName: file.name,
          contentType: file.type,
          data,
          version,
        }),
      },
    );
  },
  removeFormRecordAttachment: (
    id: string,
    recordId: string,
    attachmentId: string,
    version: number,
    csrfToken: string,
  ) =>
    request<FormRecordDetail>(
      `/data-sources/${id}/records/${recordId}/attachments/${attachmentId}?version=${version}`,
      { method: "DELETE", headers: { "X-CSRF-Token": csrfToken } },
    ),
  // The stable URL for a record's attachment image (served with session credentials).
  formAttachmentContentUrl: (
    id: string,
    recordId: string,
    attachmentId: string,
  ) =>
    `/api/v1/data-sources/${id}/records/${recordId}/attachments/${attachmentId}/content`,
  // Workflow, views, outputs, and access (Studio 2C).
  configureFormWorkflow: (
    id: string,
    workflow: FormWorkflow,
    csrfToken: string,
  ) =>
    request<FormDataSource>(`/data-sources/${id}/form/workflow`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(workflow),
    }),
  upsertFormView: (id: string, input: FormViewInput, csrfToken: string) =>
    request<FormView>(`/data-sources/${id}/views`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  previewFormView: (id: string, input: FormViewInput, csrfToken: string) =>
    request<FormTypedDataset>(`/data-sources/${id}/views/preview`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteFormView: (id: string, viewId: string, csrfToken: string) =>
    request<void>(`/data-sources/${id}/views/${viewId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  getFormOutputs: (id: string) =>
    request<FormOutputs>(`/data-sources/${id}/outputs`),
  rebuildFormOutputs: (id: string, csrfToken: string) =>
    request<FormOutputs>(`/data-sources/${id}/outputs/rebuild`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  listFormAccess: (id: string) =>
    request<{ entries: FormAccessEntry[] }>(`/data-sources/${id}/access`).then(
      (result) => result.entries,
    ),
  replaceFormGrants: (
    id: string,
    userId: string,
    capabilities: string[],
    csrfToken: string,
  ) =>
    request<{ entries: FormAccessEntry[] }>(
      `/data-sources/${id}/access/${userId}`,
      {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ capabilities }),
      },
    ).then((result) => result.entries),
  searchFormUsers: (id: string, search: string) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    const encoded = query.toString();
    return request<{ items: FormDirectoryUser[] }>(
      `/data-sources/${id}/user-directory${encoded ? `?${encoded}` : ""}`,
    ).then((result) => result.items);
  },
  // Central approvals inbox.
  listApprovals: (params?: { page?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params?.page) query.set("page", String(params.page));
    if (params?.pageSize) query.set("pageSize", String(params.pageSize));
    const encoded = query.toString();
    return request<FormApprovalPage>(
      `/approvals${encoded ? `?${encoded}` : ""}`,
    );
  },
  dataSourceDiagnostics: (id: string) =>
    request<SourceRefreshDiagnostics>(`/data-sources/${id}/diagnostics`),
  previewDataSource: (
    provider: DataSourceProvider,
    configuration:
      | CalendarConfig
      | StructuredSourceConfig
      | ManualSourceConfig
      | WeatherSourceConfig
      | TransitSourceConfig
      | CAPAlertsSourceConfig
      | AirQualitySourceConfig,
    csrfToken: string,
    previewDate?: string,
  ) =>
    request<
      | StructuredPreview
      | CalendarPreview
      | TypedRecordData
      | TypedDatasetPayload
    >(`/data-sources/${provider}/preview`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ configuration, previewDate }),
    }),
  // Report the fields a candidate RSS, Atom, JSON, or CSV connection contains, before a
  // mapping exists, so Studio can offer detected fields rather than typed guesses.
  inspectDataSource: (
    provider: DataSourceProvider,
    configuration: StructuredSourceConfig,
    csrfToken: string,
  ) =>
    request<StructuredInspection>(`/data-sources/${provider}/inspect`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ configuration }),
    }),
  // Detect fields for a saved Source. A saved CSV upload's bytes stay on the server, so the
  // editor cannot send a configuration back for detection.
  inspectSavedDataSource: (id: string) =>
    request<StructuredInspection>(`/data-sources/${id}/inspect`),
  // Preview a saved Data Source by id using its full stored configuration
  // (including uploaded CSV content the detail response strips).
  previewSavedDataSource: (id: string, previewDate?: string) => {
    const query = previewDate
      ? `?previewDate=${encodeURIComponent(previewDate)}`
      : "";
    return request<StructuredPreview | CalendarPreview | TypedRecordData>(
      `/data-sources/${id}/preview${query}`,
    );
  },
  retryAsset: (id: string, csrfToken: string) =>
    request<Asset>(`/assets/${id}/retry`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  deleteAsset: (id: string, csrfToken: string) =>
    request<void>(`/assets/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  createUpload: (
    input: { filename: string; mimeType: string; sizeBytes: number },
    csrfToken: string,
  ) =>
    request<UploadSession>("/uploads", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
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
  completeUpload: (id: string, csrfToken: string) =>
    request<Asset>(`/uploads/${id}/complete`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  cancelUpload: (id: string, csrfToken: string) =>
    request<void>(`/uploads/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  playlists: async (search = "") => {
    const result = await request<PlaylistList | null>(
      `/playlists?page=1&pageSize=100&search=${encodeURIComponent(search)}`,
    );
    return normalizePlaylistList(result);
  },
  playlist: (id: string) => requestPlaylist(`/playlists/${id}`),
  createPlaylist: (
    input: {
      name: string;
      description: string;
      sourceType: "static" | "tag";
    },
    csrfToken: string,
  ) =>
    requestPlaylist("/playlists", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updatePlaylist: (
    id: string,
    input: { name: string; description: string },
    csrfToken: string,
  ) =>
    requestPlaylist(`/playlists/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  duplicatePlaylist: (id: string, csrfToken: string) =>
    requestPlaylist(`/playlists/${id}/duplicate`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  deletePlaylist: (id: string, csrfToken: string) =>
    request<void>(`/playlists/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  addPlaylistItem: (id: string, input: PlaylistItemInput, csrfToken: string) =>
    requestPlaylist(`/playlists/${id}/items`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updatePlaylistItem: (
    id: string,
    itemId: string,
    input: PlaylistItemInput,
    csrfToken: string,
  ) =>
    requestPlaylist(`/playlists/${id}/items/${itemId}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deletePlaylistItem: (id: string, itemId: string, csrfToken: string) =>
    requestPlaylist(`/playlists/${id}/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  reorderPlaylist: (id: string, itemIds: string[], csrfToken: string) =>
    requestPlaylist(`/playlists/${id}/items/order`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ itemIds }),
    }),
  bulkUpdatePlaylistItems: (
    id: string,
    input: PlaylistBulkItemUpdateInput,
    csrfToken: string,
  ) =>
    requestPlaylist(`/playlists/${id}/items/bulk`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  playlistAssignment: async (screenId: string) =>
    normalizePlaylistAssignment(
      await request<PlaylistAssignment | null>(
        `/screens/${screenId}/playlist-assignment`,
      ),
    ),
  assignPlaylist: async (
    screenId: string,
    playlistId: string,
    csrfToken: string,
  ) =>
    normalizePlaylistAssignment(
      await request<PlaylistAssignment | null>(
        `/screens/${screenId}/playlist-assignment`,
        {
          method: "PUT",
          headers: { "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ playlistId }),
        },
      ),
    ),
  assignLayout: async (screenId: string, layoutId: string, csrfToken: string) =>
    normalizePlaylistAssignment(
      await request<PlaylistAssignment | null>(
        `/screens/${screenId}/playlist-assignment`,
        {
          method: "PUT",
          headers: { "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ layoutId }),
        },
      ),
    ),
  unassignPlaylist: async (screenId: string, csrfToken: string) =>
    normalizePlaylistAssignment(
      await request<PlaylistAssignment | null>(
        `/screens/${screenId}/playlist-assignment`,
        {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfToken },
        },
      ),
    ),
  screenGroups: async (search = "") => {
    const result = await request<ScreenGroupList>(
      `/screen-groups?page=1&pageSize=100&search=${encodeURIComponent(search)}`,
    );
    return {
      ...result,
      items: (Array.isArray(result.items) ? result.items : []).map(
        normalizeScreenGroup,
      ),
    };
  },
  screenGroup: async (id: string) =>
    normalizeScreenGroup(await request<ScreenGroup>(`/screen-groups/${id}`)),
  spanStatus: async (id: string) =>
    request<SpanStatus>(`/screen-groups/${id}/span`),
  displayControlGroupPreview: async (
    id: string,
    commandType: DisplayControlGroupPreview["commandType"],
  ) =>
    request<DisplayControlGroupPreview>(
      `/screen-groups/${id}/display-control/preview?commandType=${encodeURIComponent(commandType)}`,
    ),
  applyDisplayControlGroup: async (
    id: string,
    commandType: DisplayControlGroupPreview["commandType"],
    fingerprint: string,
    csrfToken: string,
  ) =>
    request<DisplayControlGroupApplyResult>(
      `/screen-groups/${id}/display-control`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ commandType, fingerprint }),
      },
    ),
  updateSpanGeometry: async (
    id: string,
    input: {
      displayMode?: "mirror" | "span";
      canvas?: { width: number; height: number };
      panels?: SpanStatus["geometry"]["panels"];
    },
    csrfToken: string,
  ) =>
    normalizeScreenGroup(
      await request<ScreenGroup>(`/screen-groups/${id}/span`, {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(input),
      }),
    ),
  createScreenGroup: async (
    input: { name: string; description: string },
    csrfToken: string,
  ) =>
    normalizeScreenGroup(
      await request<ScreenGroup>("/screen-groups", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(input),
      }),
    ),
  updateScreenGroup: async (
    id: string,
    input: {
      name: string;
      description: string;
      presentationGatewayScreenId?: string;
      clearPresentationGateway?: boolean;
    },
    csrfToken: string,
  ) =>
    normalizeScreenGroup(
      await request<ScreenGroup>(`/screen-groups/${id}`, {
        method: "PATCH",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(input),
      }),
    ),
  deleteScreenGroup: (id: string, csrfToken: string) =>
    request<void>(`/screen-groups/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  addScreenToGroup: (id: string, screenId: string, csrfToken: string) =>
    request<ScreenGroup>(`/screen-groups/${id}/screens`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ screenId }),
    }),
  removeScreenFromGroup: (id: string, screenId: string, csrfToken: string) =>
    request<void>(`/screen-groups/${id}/screens/${screenId}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  assignSyncGroupPlaylist: (
    id: string,
    playlistId: string,
    csrfToken: string,
  ) =>
    request<ScreenGroup>(`/screen-groups/${id}/playlist-assignment`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ playlistId }),
    }),
  assignSyncGroupLayout: (id: string, layoutId: string, csrfToken: string) =>
    request<ScreenGroup>(`/screen-groups/${id}/playlist-assignment`, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ layoutId }),
    }),
  unassignSyncGroupPlaylist: (id: string, csrfToken: string) =>
    request<ScreenGroup>(`/screen-groups/${id}/playlist-assignment`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  schedules: (search = "") =>
    request<ScheduleList>(
      `/schedules?page=1&pageSize=100&search=${encodeURIComponent(search)}`,
    ),
  schedule: (id: string) => request<Schedule>(`/schedules/${id}`),
  createSchedule: (input: ScheduleInput, csrfToken: string) =>
    request<Schedule>("/schedules", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  updateSchedule: (id: string, input: ScheduleInput, csrfToken: string) =>
    request<Schedule>(`/schedules/${id}`, {
      method: "PATCH",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(input),
    }),
  deleteSchedule: (id: string, csrfToken: string) =>
    request<void>(`/schedules/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  setScheduleEnabled: (id: string, enabled: boolean, csrfToken: string) =>
    request<Schedule>(`/schedules/${id}/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  previewSchedule: (
    screenId: string,
    timestamp: string,
    proposedSchedule?: ScheduleInput,
  ) =>
    request<SchedulePreview>("/schedules/preview", {
      method: "POST",
      body: JSON.stringify({ screenId, timestamp, proposedSchedule }),
    }),
};
