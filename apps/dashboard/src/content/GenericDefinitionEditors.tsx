import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
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
import { toast } from "../components/ui/toast";
import { useFormatLocale } from "../i18n";
import { widgetSaveErrorMessage } from "./SourceEditors";
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
  const { t } = useTranslation(["content", "common"]);
  const formatLocale = useFormatLocale();
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
        throw new Error(t("widgets.errors.previewWait"));
      const previewImage = await captureWidgetPreview(previewRef.current, t);
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
      toast.add({
        title: asset ? "Widget updated." : "Widget created.",
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });
  return (
    <GenericEditorShell
      title={
        asset
          ? t("widgets.editors.generic.editTitle", { name: definition.name })
          : t("widgets.editors.generic.createTitle", { name: definition.name })
      }
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
      saveLabel={t("widgets.editors.generic.saveWidget")}
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
            <span>{t("widgets.editors.generic.preparing")}</span>
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
        <div
          className="source-diagnostics"
          aria-label={t("widgets.editors.generic.diagnostics.label")}
        >
          <strong>{t("widgets.editors.generic.diagnostics.title")}</strong>
          <p>
            {managedSourceDiagnostics.data.usingCachedData
              ? t("widgets.editors.generic.diagnostics.summaryCached", {
                  status:
                    managedSourceDiagnostics.data.parseStatus ||
                    t("widgets.editors.generic.diagnostics.statusPending"),
                  count: managedSourceDiagnostics.data.availableItemCount,
                })
              : t("widgets.editors.generic.diagnostics.summary", {
                  status:
                    managedSourceDiagnostics.data.parseStatus ||
                    t("widgets.editors.generic.diagnostics.statusPending"),
                  count: managedSourceDiagnostics.data.availableItemCount,
                })}
          </p>
          <p>
            {managedSourceDiagnostics.data.lastSuccessfulRefresh
              ? t("widgets.editors.generic.diagnostics.lastUpdate", {
                  date: new Date(
                    managedSourceDiagnostics.data.lastSuccessfulRefresh,
                  ).toLocaleString(formatLocale),
                })
              : t("widgets.editors.generic.diagnostics.lastUpdateNever")}
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
  const { t } = useTranslation(["content", "common"]);
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
      toast.add({
        title: dataSource ? "Data Source updated." : "Data Source created.",
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  return (
    <GenericEditorShell
      title={
        dataSource
          ? t("widgets.editors.generic.editTitle", { name: definition.name })
          : t("widgets.editors.generic.createTitle", { name: definition.name })
      }
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
      saveLabel={t("widgets.editors.generic.saveDataSource")}
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
  const { t } = useTranslation(["content", "common"]);
  const isWidget = Boolean(preview);
  const nameId = useId();
  const detailId = useId();
  const details = (
    <div className="form-grid">
      <Field>
        <FieldLabel htmlFor={nameId}>
          {isWidget
            ? t("widgets.editors.generic.widgetName")
            : t("widgets.editors.generic.dataSourceName")}
        </FieldLabel>
        <Input
          id={nameId}
          value={name}
          disabled={readOnly}
          maxLength={180}
          onChange={(event) => setName(event.target.value)}
        />
        <FieldDescription>
          {isWidget
            ? t("widgets.editors.generic.widgetNameHint")
            : t("widgets.editors.generic.dataSourceNameHint")}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={detailId}>
          {t("widgets.editors.generic.description")}
        </FieldLabel>
        <Textarea
          id={detailId}
          value={detail}
          disabled={readOnly}
          maxLength={2000}
          onChange={(event) => setDetail(event.target.value)}
        />
        <FieldDescription>
          {t("widgets.editors.generic.descriptionHint")}
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
            {t("common:actions.close")}
          </Button>
        </header>
        {preview ? (
          <div className="widget-editor__layout">
            <div className="widget-editor__form">
              <EditorSection
                title={t("widgets.editors.generic.detailsTitle")}
                description={t("widgets.editors.generic.detailsHint")}
              >
                {details}
              </EditorSection>
              <EditorSection
                title={t("widgets.editors.generic.contentTitle")}
                description={t("widgets.editors.generic.contentHint")}
              >
                {children}
              </EditorSection>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {widgetSaveErrorMessage(t, error)}
                  </AlertDescription>
                </Alert>
              )}
            </div>
            <aside
              className="widget-editor__preview"
              aria-label={t("widgets.editors.generic.previewLabel")}
            >
              <header>
                <strong>{t("widgets.editors.generic.previewLabel")}</strong>
                <span>{t("widgets.editors.generic.previewHint")}</span>
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
                  {widgetSaveErrorMessage(t, error)}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <footer>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          {!readOnly && (
            <Button
              disabled={pending || saveDisabled || !name.trim()}
              onClick={onSave}
            >
              {pending ? t("common:actions.saving") : saveLabel}
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
