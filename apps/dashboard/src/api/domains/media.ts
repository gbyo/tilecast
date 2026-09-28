/**
 * Media, widgets, and data-source domain helpers over the typed
 * transport. Path, query, and body shapes come from the generated
 * OpenAPI contract. Asset library, content organization, data source
 * CRUD/diagnostics/inspection, and definition catalog success bodies are
 * contract-typed and inferred from the generated schemas; widgets,
 * uploads, and preview payloads still state their local Studio response
 * type explicitly until the contract gains schemas.
 * Blob/streaming upload paths stay on raw fetch in ../client.ts:
 * genuinely exceptional transports.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "../transport";
import type { components } from "@tilecast/api-schema/generated/openapi";
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
  DataSourceProvider,
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
  WidgetPresentation,
} from "../types";

function fromSearchParams(
  params: URLSearchParams,
): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of params) {
    const numeric = Number(value);
    query[key] =
      value === ""
        ? value
        : Number.isNaN(numeric) || !/^-?\d+(\.\d+)?$/.test(value)
          ? value
          : numeric;
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
    params: { query: fromSearchParams(params) },
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
  return apiGet<"/api/v1/assets/{id}/website/diagnostics", WebsiteDiagnostics>(
    "/api/v1/assets/{id}/website/diagnostics",
    { params: { path: { id } } },
  );
}

export function compileWidgetPreview(
  provider: WidgetInput["provider"],
  configuration: WidgetInput["configuration"],
  csrfToken: string,
): Promise<WidgetPresentation> {
  return apiPost<"/api/v1/widgets/compile-preview", WidgetPresentation>(
    "/api/v1/widgets/compile-preview",
    { body: { provider, configuration }, csrfToken },
  );
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
      query: fromSearchParams(
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

export function previewDataSource(
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
): Promise<
  StructuredPreview | CalendarPreview | TypedRecordData | TypedDatasetPayload
> {
  return apiPost<
    "/api/v1/data-sources/{provider}/preview",
    StructuredPreview | CalendarPreview | TypedRecordData | TypedDatasetPayload
  >("/api/v1/data-sources/{provider}/preview", {
    params: { path: { provider } },
    body: { configuration, previewDate },
    csrfToken,
  });
}

export function inspectDataSource(
  provider: DataSourceProvider,
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
): Promise<StructuredPreview | CalendarPreview | TypedRecordData> {
  return apiGet<
    "/api/v1/data-sources/{id}/preview",
    StructuredPreview | CalendarPreview | TypedRecordData
  >("/api/v1/data-sources/{id}/preview", {
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
