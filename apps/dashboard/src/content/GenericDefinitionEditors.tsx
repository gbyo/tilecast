import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type {
  Asset,
  DataSourceDefinition,
  DataSourceDetail,
  WidgetDefinition,
} from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { DefinitionForm } from "./DefinitionForm";
import { previewDatasetMaps, type PreviewDatasets } from "./previewRecords";
import { DeclarativePresentationPreview } from "./SourceEditors";
import { PreviewTimeControl } from "./PreviewTimeControl";
import {
  initialPreviewTime,
  resolvePreviewNow,
  type PreviewTime,
} from "./previewTime";
import { captureWidgetPreview } from "./widgetPreviewCapture";
import {
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
} from "./widgetPreviewSources";

export function GenericWidgetEditor({
  definition,
  asset,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
}: {
  definition: WidgetDefinition;
  asset?: Asset;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (asset: Asset) => void;
}) {
  const queryClient = useQueryClient();
  const previewRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(asset?.name ?? definition.name);
  const [description, setDescription] = useState(
    asset?.description ?? definition.description,
  );
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    asset?.widget?.authorConfiguration ??
      asset?.widget?.configuration ??
      definition.defaultConfiguration,
  );
  const [previewTime, setPreviewTime] =
    useState<PreviewTime>(initialPreviewTime);
  const managedDataSourceId = asset?.widget?.managedDataSourceId;
  const previewConfiguration = widgetPreviewConfiguration(
    configuration,
    managedDataSourceId,
  );
  const isAppRecipe = Boolean(
    (definition as WidgetDefinition & { recipe?: unknown }).recipe,
  );
  const managedSourceDiagnostics = useQuery({
    queryKey: ["data-source-diagnostics", managedDataSourceId],
    queryFn: () => api.dataSourceDiagnostics(managedDataSourceId ?? ""),
    enabled: Boolean(managedDataSourceId),
    retry: false,
    refetchInterval: 10_000,
  });
  const compiledPreview = useQuery({
    queryKey: ["compiled-widget-preview", definition.id, previewConfiguration],
    queryFn: () =>
      api.compileWidgetPreview(definition.id, previewConfiguration, csrf),
    retry: false,
  });
  // Follow every author-declared `data_source` control and explicitly include an App Recipe's
  // hidden managed source. The managed source comes first because source-backed Apps intentionally
  // do not expose a data_source control even though their presentation binds to sourceId.
  const dataSourceIds = widgetPreviewDataSourceIds(
    definition.configurationSchema.fields,
    configuration,
    managedDataSourceId,
  );
  const sourcePreviews = useQueries({
    queries: dataSourceIds.map((id) => ({
      queryKey: ["widget-data-source-preview", id],
      queryFn: () => api.previewSavedDataSource(id),
      retry: false,
    })),
  });
  const sourcesLoading = sourcePreviews.some((preview) => preview.isLoading);
  const primarySourcePreview = sourcePreviews[0]?.data;
  // Bindings name their dataset "<dataSourceId>:<datasetId>", so every referenced source is
  // normalized under that key. A Widget reading two sources now renders each binding from the
  // source it actually names rather than from whichever was declared first.
  const previewDatasets = dataSourceIds.reduce<PreviewDatasets>(
    (all, id, index) => ({
      ...all,
      ...previewDatasetMaps(id, sourcePreviews[index]?.data),
    }),
    {},
  );
  const save = useMutation({
    mutationFn: async () => {
      const input = {
        provider: definition.id,
        name,
        description,
        configuration,
      };

      // An App Recipe's managed Data Source is provisioned/updated by the save itself. Capturing
      // before that transaction necessarily depicts the old or empty source. Let the snapshot
      // backfill capture the saved App after its managed source exists and has been reconnected.
      if (isAppRecipe) {
        return asset
          ? api.updateWidget(asset.id, input, csrf)
          : api.createWidget(input, csrf);
      }

      if (!previewRef.current || !compiledPreview.data || sourcesLoading)
        throw new Error("Wait for the Widget preview before saving.");
      const previewImage = await captureWidgetPreview(previewRef.current);
      const saved = asset
        ? api.updateWidget(asset.id, input, csrf)
        : api.createWidget(input, csrf);
      const result = await saved;
      await api.uploadWidgetPreview(result.id, previewImage, csrf);
      return {
        ...result,
        thumbnailUrl: `/api/v1/assets/${encodeURIComponent(result.id)}/thumbnail`,
      };
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });
  return (
    <GenericEditorShell
      title={`${asset ? "Edit" : "Create"} ${definition.name}`}
      description={definition.description}
      name={name}
      setName={setName}
      detail={description}
      setDetail={setDescription}
      readOnly={readOnly}
      pending={save.isPending}
      saveDisabled={!compiledPreview.data || sourcesLoading}
      error={save.error}
      onClose={onClose}
      onSave={() => save.mutate()}
      saveLabel="Save Widget"
      previewControl={
        <PreviewTimeControl value={previewTime} onChange={setPreviewTime} />
      }
      preview={
        <div
          ref={previewRef}
          className="native-app-preview declarative-widget-preview"
        >
          {compiledPreview.data ? (
            <DeclarativePresentationPreview
              presentation={compiledPreview.data}
              source={primarySourcePreview}
              datasets={previewDatasets}
              now={resolvePreviewNow(previewTime)}
              assetImageUrl={
                typeof configuration.imageAssetId === "string" &&
                configuration.imageAssetId
                  ? api.assetPreviewUrl(configuration.imageAssetId)
                  : undefined
              }
            />
          ) : (
            <span>Preparing preview…</span>
          )}
        </div>
      }
    >
      <DefinitionForm
        fields={definition.configurationSchema.fields}
        value={configuration}
        onChange={setConfiguration}
        readOnly={readOnly}
        csrf={csrf}
      />
      {managedSourceDiagnostics.data && (
        <div className="source-diagnostics" aria-label="App source health">
          <strong>App source</strong>
          <p>
            {managedSourceDiagnostics.data.parseStatus || "Pending"} ·{" "}
            {managedSourceDiagnostics.data.availableItemCount} items
            {managedSourceDiagnostics.data.usingCachedData
              ? " · using cached data"
              : ""}
          </p>
          <p>
            Last successful update:{" "}
            {managedSourceDiagnostics.data.lastSuccessfulRefresh
              ? new Date(
                  managedSourceDiagnostics.data.lastSuccessfulRefresh,
                ).toLocaleString()
              : "not yet"}
          </p>
        </div>
      )}
    </GenericEditorShell>
  );
}

export function GenericDataSourceEditor({
  definition,
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
}: {
  definition: DataSourceDefinition;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (source: DataSourceDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? definition.name);
  const [description, setDescription] = useState(
    dataSource?.description ?? definition.description,
  );
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    dataSource?.configuration ?? definition.defaultConfiguration,
  );
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: definition.id,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  return (
    <GenericEditorShell
      title={`${dataSource ? "Edit" : "Create"} ${definition.name}`}
      description={definition.description}
      name={name}
      setName={setName}
      detail={description}
      setDetail={setDescription}
      readOnly={readOnly}
      pending={save.isPending}
      saveDisabled={false}
      error={save.error}
      onClose={onClose}
      onSave={() => save.mutate()}
      saveLabel="Save Data Source"
    >
      <DefinitionForm
        fields={definition.configurationSchema.fields}
        value={configuration}
        onChange={setConfiguration}
        readOnly={readOnly}
        csrf={csrf}
      />
    </GenericEditorShell>
  );
}

function GenericEditorShell({
  title,
  description,
  name,
  setName,
  detail,
  setDetail,
  readOnly,
  pending,
  saveDisabled,
  error,
  onClose,
  onSave,
  saveLabel,
  preview,
  previewControl,
  children,
}: {
  title: string;
  description: string;
  name: string;
  setName: (value: string) => void;
  detail: string;
  setDetail: (value: string) => void;
  readOnly: boolean;
  pending: boolean;
  saveDisabled: boolean;
  error: Error | null;
  onClose: () => void;
  onSave: () => void;
  saveLabel: string;
  preview?: ReactNode;
  previewControl?: ReactNode;
  children: ReactNode;
}) {
  const subject = preview ? "Widget" : "Data Source";
  const nameId = useId();
  const detailId = useId();
  const details = (
    <div className="form-grid">
      <Field>
        <FieldLabel htmlFor={nameId}>{subject} name</FieldLabel>
        <Input
          id={nameId}
          value={name}
          disabled={readOnly}
          maxLength={180}
          onChange={(event) => setName(event.target.value)}
        />
        <FieldDescription>Used to find this {subject} later.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={detailId}>Description</FieldLabel>
        <Textarea
          id={detailId}
          value={detail}
          disabled={readOnly}
          maxLength={2000}
          onChange={(event) => setDetail(event.target.value)}
        />
        <FieldDescription>
          Optional notes for other people managing this installation.
        </FieldDescription>
      </Field>
    </div>
  );
  return (
    <div className="details-backdrop">
      <section
        className={`asset-details source-editor${preview ? " widget-editor" : ""}`}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        {preview ? (
          <div className="widget-editor__layout">
            <div className="widget-editor__form">
              <EditorSection
                title="Widget details"
                description="Name this Widget so it is easy to recognize later."
              >
                {details}
              </EditorSection>
              <EditorSection
                title="Content and appearance"
                description="Choose what appears on screen and how it should be presented."
              >
                {children}
              </EditorSection>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {error instanceof ApiError ? error.message : error.message}
                  </AlertDescription>
                </Alert>
              )}
            </div>
            <aside className="widget-editor__preview" aria-label="Live preview">
              <header>
                <strong>Live preview</strong>
                <span>Updates as you make changes.</span>
              </header>
              {previewControl}
              {preview}
            </aside>
          </div>
        ) : (
          <div className="source-editor__body">
            {details}
            {children}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {error instanceof ApiError ? error.message : error.message}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <footer>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!readOnly && (
            <Button
              disabled={pending || saveDisabled || !name.trim()}
              onClick={onSave}
            >
              {pending ? "Saving…" : saveLabel}
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}

function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="widget-editor__section">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="widget-editor__section-body">{children}</div>
    </section>
  );
}
