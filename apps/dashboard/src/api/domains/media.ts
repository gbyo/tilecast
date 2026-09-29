/**
 * Media, widgets, and data-source domain helpers over the typed
 * transport. Path, query, body, and success shapes all come from the
 * generated OpenAPI contract. Where a Studio view differs from the wire
 * shape, a named normalizer in this module bridges the two, and the
 * provider-dependent preview route is narrowed per shape by guard.
 * Blob, chunked, and HEAD-inspection upload paths stay on raw fetch in
 * ../client.ts: genuinely exceptional transports.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "../transport";
import { ApiError, FALLBACK_REQUEST_MESSAGE } from "../errors";
import type { components, paths } from "@tilecast/api-schema/generated/openapi";
import type {
  AirQualitySourceConfig,
  Asset,
  BulkOrganizeInput,
  CalendarConfig,
  CalendarPreview,
  CAPAlertsSourceConfig,
  ContentCollection,
  ContentDefinitionCatalog,
  ContentFolder,
  ContentTag,
  DataSourceDetail,
  DataSourceInput,
  DataSourceListResult,
  ManualSourceConfig,
  ProviderCatalog,
  SourceRefreshDiagnostics,
  StructuredInspection,
  StructuredPreview,
  StructuredSourceConfig,
  TransitSourceConfig,
  TypedDatasetPayload,
  TypedRecordData,
  UploadSession,
  WeatherSourceConfig,
  WebsiteDiagnostics,
  WebsiteInput,
  WidgetInput,
} from "../types";

type ListQuery = NonNullable<
  paths["/api/v1/assets"]["get"]["parameters"]["query"]
>;

/**
 * The list parameters the contract declares as integers. Every other value
 * is a string, and stays one: a search for `0042` must reach the Server as
 * `0042`, not `42`. The `satisfies` check keeps these names in the
 * contract.
 */
const integerQueryParameters: ReadonlySet<string> = new Set([
  "page",
  "pageSize",
] as const satisfies readonly (keyof ListQuery)[]);

export function queryFromSearchParams(
  params: URLSearchParams,
): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  for (const [key, value] of params) {
    query[key] =
      integerQueryParameters.has(key) && /^\d+$/.test(value)
        ? Number(value)
        : value;
  }
  return query;
}

/** Wire shapes of the definition catalogs from the generated contract. */
export type WireProviderCatalog = components["schemas"]["ProviderCatalog"];
export type WireContentDefinitionCatalog =
  components["schemas"]["ContentDefinitionCatalog"];

export function normalizeProviderCatalog(
  catalog: ProviderCatalog | WireProviderCatalog | null | undefined,
): ProviderCatalog {
  const source = catalog ?? ({} as ProviderCatalog);
  return {
    ...source,
    revision: source.revision ?? 1,
    providers: Array.isArray(source.providers) ? source.providers : [],
  };
}

export function normalizeContentDefinitionCatalog(
  catalog:
    ContentDefinitionCatalog | WireContentDefinitionCatalog | null | undefined,
): ContentDefinitionCatalog {
  const source = catalog ?? ({} as ContentDefinitionCatalog);
  return {
    ...source,
    // A definition without overrides serializes defaultConfiguration as
    // null; the Studio view models it as an absent-or-object map.
    widgets: (Array.isArray(source.widgets) ? source.widgets : []).map(
      (widget) => ({
        ...widget,
        defaultConfiguration: widget.defaultConfiguration ?? {},
      }),
    ),
    dataSources: (Array.isArray(source.dataSources)
      ? source.dataSources
      : []
    ).map((definition) => ({
      ...definition,
      defaultConfiguration: definition.defaultConfiguration ?? {},
    })),
  };
}

export async function getProviderCatalog(): Promise<ProviderCatalog> {
  return normalizeProviderCatalog(await apiGet("/api/v1/provider-catalog"));
}

export async function getContentDefinitions(): Promise<ContentDefinitionCatalog> {
  return normalizeContentDefinitionCatalog(
    await apiGet("/api/v1/content-definitions"),
  );
}

export function listAssets(params: URLSearchParams) {
  return apiGet("/api/v1/assets", {
    params: { query: queryFromSearchParams(params) },
  });
}

export function listContentFolders(): Promise<ContentFolder[]> {
  return apiGet("/api/v1/content-folders");
}

export function createContentFolder(
  input: { name: string; description: string; parentId?: string },
  csrfToken: string,
): Promise<ContentFolder> {
  return apiPost("/api/v1/content-folders", { body: input, csrfToken });
}

export function updateContentFolder(
  id: string,
  input: { name: string; description: string; parentId?: string },
  csrfToken: string,
): Promise<ContentFolder> {
  return apiPatch("/api/v1/content-folders/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deleteContentFolder(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/content-folders/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listContentCollections(): Promise<ContentCollection[]> {
  return apiGet("/api/v1/content-collections");
}

export function createContentCollection(
  input: { name: string; description: string },
  csrfToken: string,
): Promise<ContentCollection> {
  return apiPost("/api/v1/content-collections", { body: input, csrfToken });
}

export function updateContentCollection(
  id: string,
  input: { name: string; description: string },
  csrfToken: string,
): Promise<ContentCollection> {
  return apiPatch("/api/v1/content-collections/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deleteContentCollection(
  id: string,
  csrfToken: string,
): Promise<void> {
  return apiDelete("/api/v1/content-collections/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function listContentTags(): Promise<ContentTag[]> {
  return apiGet("/api/v1/content-tags");
}

export function createContentTag(
  input: { name: string; color: string },
  csrfToken: string,
): Promise<ContentTag> {
  return apiPost("/api/v1/content-tags", { body: input, csrfToken });
}

export function updateContentTag(
  id: string,
  input: { name: string; color: string },
  csrfToken: string,
): Promise<ContentTag> {
  return apiPatch("/api/v1/content-tags/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function deleteContentTag(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/content-tags/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function bulkOrganize(input: BulkOrganizeInput, csrfToken: string) {
  return apiPost("/api/v1/assets/bulk-organize", { body: input, csrfToken });
}

export function archiveAssets(assetIds: string[], csrfToken: string) {
  return apiPost("/api/v1/assets/archive", {
    body: { assetIds },
    csrfToken,
  });
}

export function restoreAssets(assetIds: string[], csrfToken: string) {
  return apiPost("/api/v1/assets/restore", {
    body: { assetIds },
    csrfToken,
  });
}

export function getAsset(id: string) {
  return apiGet("/api/v1/assets/{id}", {
    params: { path: { id } },
  });
}

export function updateAsset(
  id: string,
  input: {
    name?: string;
    description?: string;
    availabilitySet?: boolean;
    availableFrom?: string;
    expiresAt?: string;
  },
  csrfToken: string,
) {
  return apiPatch("/api/v1/assets/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function retryAsset(id: string, csrfToken: string) {
  return apiPost("/api/v1/assets/{id}/retry", {
    params: { path: { id } },
    csrfToken,
  });
}

export function deleteAsset(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/assets/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export function createWebsite(input: WebsiteInput, csrfToken: string) {
  return apiPost("/api/v1/assets/websites", {
    body: input,
    csrfToken,
  });
}

export function updateWebsite(
  id: string,
  input: WebsiteInput,
  csrfToken: string,
) {
  return apiPatch("/api/v1/assets/{id}/website", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function getWebsiteDiagnostics(id: string): Promise<WebsiteDiagnostics> {
  return apiGet("/api/v1/assets/{id}/website/diagnostics", {
    params: { path: { id } },
  });
}

/**
 * Wire shape of a compiled Widget presentation from the generated
 * contract. Definitions without a player fallback answer null, which
 * callers already treat as a pending preview.
 */
export type WireCompiledWidgetPresentation =
  components["schemas"]["CompiledWidgetPresentation"] | null;

export function compileWidgetPreview(
  provider: WidgetInput["provider"],
  configuration: WidgetInput["configuration"],
  csrfToken: string,
): Promise<WireCompiledWidgetPresentation> {
  return apiPost("/api/v1/widgets/compile-preview", {
    body: { provider, configuration },
    csrfToken,
  });
}

export function createWidget(
  input: WidgetInput,
  csrfToken: string,
): Promise<Asset> {
  return apiPost("/api/v1/widgets", { body: input, csrfToken });
}

export function updateWidget(
  id: string,
  input: WidgetInput,
  csrfToken: string,
): Promise<Asset> {
  return apiPatch("/api/v1/widgets/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function duplicateWidget(id: string, csrfToken: string): Promise<Asset> {
  return apiPost("/api/v1/widgets/{id}/duplicate", {
    params: { path: { id } },
    csrfToken,
  });
}

/** Wire shapes of data sources from the generated contract. */
export type WireDataSource = components["schemas"]["DataSource"];
export type WireDataSourceDetail = components["schemas"]["DataSourceDetail"];
export type WireDataSourceDiagnostics =
  components["schemas"]["DataSourceDiagnostics"];

export function listDataSources(
  params?: URLSearchParams,
): Promise<DataSourceListResult> {
  return apiGet("/api/v1/data-sources", {
    params: {
      query: queryFromSearchParams(
        params ?? new URLSearchParams({ page: "1", pageSize: "100" }),
      ),
    },
  });
}

export async function getDataSource(id: string): Promise<DataSourceDetail> {
  return normalizeDataSourceDetail(
    await apiGet("/api/v1/data-sources/{id}", {
      params: { path: { id } },
    }),
  );
}

/**
 * The wire diagnostics carry the source id as dataSourceId; the Studio
 * view inherited the name assetId. The bridge renames it instead of
 * dropping the link between a source and its refresh state.
 */
export function normalizeDataSourceDetail(
  detail: WireDataSourceDetail,
): DataSourceDetail {
  return {
    ...detail,
    diagnostics: {
      ...detail.diagnostics,
      assetId: detail.diagnostics.dataSourceId,
    },
    fields: Array.isArray(detail.fields) ? detail.fields : [],
    widgetUsage: Array.isArray(detail.widgetUsage) ? detail.widgetUsage : [],
    bindingUsage: Array.isArray(detail.bindingUsage) ? detail.bindingUsage : [],
  };
}

export function normalizeDataSourceDiagnostics(
  diagnostics: WireDataSourceDiagnostics,
): SourceRefreshDiagnostics {
  return { ...diagnostics, assetId: diagnostics.dataSourceId };
}

export function createDataSource(
  input: DataSourceInput,
  csrfToken: string,
): Promise<WireDataSource> {
  return apiPost("/api/v1/data-sources", { body: input, csrfToken });
}

export function updateDataSource(
  id: string,
  input: DataSourceInput,
  csrfToken: string,
): Promise<WireDataSource> {
  return apiPatch("/api/v1/data-sources/{id}", {
    params: { path: { id } },
    body: input,
    csrfToken,
  });
}

export function duplicateDataSource(
  id: string,
  csrfToken: string,
): Promise<WireDataSource> {
  return apiPost("/api/v1/data-sources/{id}/duplicate", {
    params: { path: { id } },
    csrfToken,
  });
}

export function deleteDataSource(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/data-sources/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}

export async function getDataSourceDiagnostics(
  id: string,
): Promise<SourceRefreshDiagnostics> {
  return normalizeDataSourceDiagnostics(
    await apiGet("/api/v1/data-sources/{id}/diagnostics", {
      params: { path: { id } },
    }),
  );
}

/**
 * Wire shape of a provider-dependent preview from the generated contract:
 * calendar answers CalendarPreview, manual and weather answer record
 * data, live and record adapters answer a named-dataset payload, and feed
 * and document sources answer a structured preview.
 */
export type WireDataSourcePreviewResult =
  components["schemas"]["DataSourcePreviewResult"];

/** Providers the contract accepts on the preview and inspect routes. */
export type PreviewProvider =
  paths["/api/v1/data-sources/{provider}/preview"]["post"]["parameters"]["path"]["provider"];
export type InspectProvider =
  paths["/api/v1/data-sources/{provider}/inspect"]["post"]["parameters"]["path"]["provider"];

export function previewDataSource(
  provider: PreviewProvider,
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
): Promise<WireDataSourcePreviewResult> {
  return apiPost("/api/v1/data-sources/{provider}/preview", {
    params: { path: { provider } },
    body: { configuration, previewDate },
    csrfToken,
  });
}

/*
 * The preview route answers a provider-dependent shape (see
 * DataSourcePreviewResult). These guards name each shape by its
 * distinguishing member, and the per-shape wrappers below let an editor
 * that knows its provider receive exactly that shape, or a
 * malformed_response error instead of a silently wrong one.
 */
export function isCalendarPreview(
  preview: WireDataSourcePreviewResult,
): preview is CalendarPreview {
  return (
    "configuration" in preview &&
    "events" in (preview.configuration as { data: object }).data
  );
}

export function isStructuredPreview(
  preview: WireDataSourcePreviewResult,
): preview is StructuredPreview {
  return (
    "configuration" in preview &&
    "records" in (preview.configuration as { data: object }).data
  );
}

export function isTypedRecordData(
  preview: WireDataSourcePreviewResult,
): preview is TypedRecordData {
  return "records" in preview && "fields" in preview;
}

export function isTypedDatasetPayload(
  preview: WireDataSourcePreviewResult,
): preview is TypedDatasetPayload {
  return "datasets" in preview;
}

async function previewShaped<T extends WireDataSourcePreviewResult>(
  guard: (preview: WireDataSourcePreviewResult) => preview is T,
  ...args: Parameters<typeof previewDataSource>
): Promise<T> {
  const preview = await previewDataSource(...args);
  if (!guard(preview))
    throw new ApiError(FALLBACK_REQUEST_MESSAGE, 0, "malformed_response");
  return preview;
}

export function previewCalendarSource(
  configuration: CalendarConfig,
  csrfToken: string,
): Promise<CalendarPreview> {
  return previewShaped(isCalendarPreview, "calendar", configuration, csrfToken);
}

export function previewStructuredSource(
  provider: InspectProvider,
  configuration: StructuredSourceConfig,
  csrfToken: string,
  previewDate?: string,
): Promise<StructuredPreview> {
  return previewShaped(
    isStructuredPreview,
    provider,
    configuration,
    csrfToken,
    previewDate,
  );
}

export function previewRecordSource(
  provider: "manual" | "weather",
  configuration: ManualSourceConfig | WeatherSourceConfig,
  csrfToken: string,
): Promise<TypedRecordData> {
  return previewShaped(isTypedRecordData, provider, configuration, csrfToken);
}

export function previewDatasetSource(
  provider: PreviewProvider,
  configuration: Parameters<typeof previewDataSource>[1],
  csrfToken: string,
): Promise<TypedDatasetPayload> {
  return previewShaped(
    isTypedDatasetPayload,
    provider,
    configuration,
    csrfToken,
  );
}

export function inspectDataSource(
  provider: InspectProvider,
  configuration: StructuredSourceConfig,
  csrfToken: string,
): Promise<StructuredInspection> {
  return apiPost("/api/v1/data-sources/{provider}/inspect", {
    params: { path: { provider } },
    body: { configuration },
    csrfToken,
  });
}

export function inspectSavedDataSource(
  id: string,
): Promise<StructuredInspection> {
  return apiGet("/api/v1/data-sources/{id}/inspect", {
    params: { path: { id } },
  });
}

export function previewSavedDataSource(
  id: string,
  previewDate?: string,
): Promise<WireDataSourcePreviewResult> {
  return apiGet("/api/v1/data-sources/{id}/preview", {
    params: {
      path: { id },
      query: previewDate === undefined ? undefined : { previewDate },
    },
  });
}

export function createUpload(
  input: { filename: string; mimeType: string; sizeBytes: number },
  csrfToken: string,
): Promise<UploadSession> {
  return apiPost("/api/v1/uploads", { body: input, csrfToken });
}

export function completeUpload(id: string, csrfToken: string): Promise<Asset> {
  return apiPost("/api/v1/uploads/{id}/complete", {
    params: { path: { id } },
    csrfToken,
  });
}

export function cancelUpload(id: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/uploads/{id}", {
    params: { path: { id } },
    csrfToken,
  });
}
