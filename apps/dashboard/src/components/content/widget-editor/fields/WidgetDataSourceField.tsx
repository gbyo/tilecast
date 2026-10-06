/**
 * The data behind a Widget, shown as a connected resource rather than an
 * opaque value: its name, kind, health, and size, with a searchable way to
 * change it and a way to connect new data without leaving the draft.
 * Compatibility (accepted kinds, required fields) is the definition's.
 */
import { useQuery } from "@tanstack/react-query";
import { Database, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { DataSource, DataSourceProvider } from "@/api/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/studio/StudioCollapsible";
import { contentQueries } from "@/data/content";
import { ConnectDataFlow } from "@/content/DataSourceCreateFlow";
import {
  DataFormatGuidePanel,
  recordCountLabel,
  statusLabel,
} from "@/content/DataSourcePicker";
import {
  compatibleSources,
  creatableProviders,
  dataFormatGuideFor,
} from "@/content/DefinitionForm";
import {
  galleryHiddenProviders,
  providerLabel,
  sourceIcon,
} from "@/content/dataSourceProviderMeta";
import { previewRecordMaps } from "@/content/previewRecords";
import {
  fieldDomId,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";

const SAMPLE_FIELD_LIMIT = 6;

/** Every saved Data Source, shared by every source control in Studio. */
export function useDataSourceLibrary(enabled = true) {
  return useQuery({
    queryKey: ["definition-form-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled,
  });
}

export function WidgetDataSourceField({
  field,
  path,
  value,
  fields,
  onChange,
  readOnly,
  csrf,
  errorFor,
}: InspectorFieldProps) {
  const { t } = useTranslation(["content", "common"]);
  const id = fieldDomId(path);
  const error = errorFor(path);
  const selectedId = fieldText(value);
  const library = useDataSourceLibrary();
  const definitions = useQuery(contentQueries.definitions());
  const providerCatalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: api.providerCatalog,
  });
  const sources = compatibleSources(
    field,
    library.data?.items ?? [],
    definitions.data?.dataSources ?? [],
  );
  const createProviders = creatableProviders(
    field,
    definitions.data?.dataSources ?? [],
  );
  const selected = sources.find((source) => source.id === selectedId);
  const missing = Boolean(selectedId) && library.isSuccess && !selected;
  const [connecting, setConnecting] = useState<
    DataSourceProvider | "choose" | null
  >(null);
  const guide = dataFormatGuideFor(field, fields, t);
  const describedBy =
    [field.description ? `${id}-description` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const canConnect = !readOnly && Boolean(csrf) && createProviders.length > 0;

  const chooser = !readOnly && sources.length > 0 && (
    <SourceChooser
      label={field.label}
      sources={sources}
      value={selectedId}
      onChange={onChange}
      triggerId={id}
      describedBy={describedBy}
      firstChoice={!selected}
    />
  );

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldTitle id={`${id}-label`}>
        {field.label}
        {field.required && (
          <span aria-hidden="true" className="text-muted-foreground">
            *
          </span>
        )}
      </FieldTitle>
      {selected ? (
        <Item variant="outline" size="sm" aria-labelledby={`${id}-label`}>
          <ItemMedia variant="icon" aria-hidden="true">
            {sourceIcon(selected.provider, undefined, 18)}
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="truncate">{selected.name}</ItemTitle>
            <ItemDescription>{sourceSummary(selected, t)}</ItemDescription>
          </ItemContent>
          {chooser && <ItemActions>{chooser}</ItemActions>}
        </Item>
      ) : missing ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("widgets.editor.data.missing")}</span>
            {chooser}
          </AlertDescription>
        </Alert>
      ) : (
        <Item variant="muted" size="sm">
          <ItemMedia variant="icon" aria-hidden="true">
            <Database size={18} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("widgets.editor.data.none")}</ItemTitle>
            <ItemDescription>
              {library.isLoading
                ? t("widgets.editor.data.loading")
                : sources.length > 0
                  ? t("widgets.editor.data.compatible", {
                      count: sources.length,
                    })
                  : t("widgets.editor.data.noneCompatible")}
            </ItemDescription>
          </ItemContent>
          {chooser && <ItemActions>{chooser}</ItemActions>}
        </Item>
      )}
      {canConnect && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setConnecting("choose")}
        >
          <Plus aria-hidden="true" />
          {t("widgets.editor.data.connect")}
        </Button>
      )}
      {field.description && (
        <FieldDescription id={`${id}-description`}>
          {field.description}
        </FieldDescription>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      {selected ? (
        <SampleData sourceId={selected.id} />
      ) : (
        <DataFormatGuidePanel guide={guide} defaultOpen={false} />
      )}
      {connecting && (
        <ConnectDataFlow
          presentation="panel"
          provider={connecting === "choose" ? undefined : connecting}
          providers={createProviders}
          exclude={galleryHiddenProviders(providerCatalog.data)}
          csrf={csrf}
          onChooseProvider={setConnecting}
          onBack={() => setConnecting("choose")}
          onClose={() => setConnecting(null)}
          onCreated={(created) => {
            setConnecting(null);
            void library.refetch();
            onChange(created);
          }}
        />
      )}
    </Field>
  );
}

function sourceSummary(
  source: DataSource,
  t: ReturnType<typeof useTranslation<["content", "common"]>>["t"],
) {
  return [
    providerLabel(source.provider, t),
    statusLabel(source.status, t),
    recordCountLabel(source.cachedRecordCount, t),
  ]
    .filter(Boolean)
    .join(" · ");
}

function SourceChooser({
  label,
  sources,
  value,
  onChange,
  triggerId,
  describedBy,
  firstChoice,
}: {
  label: string;
  sources: readonly DataSource[];
  value: string;
  onChange: (id: string) => void;
  triggerId: string;
  describedBy: string | undefined;
  firstChoice: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const names = new Map(sources.map((source) => [source.id, source]));
  return (
    <Combobox
      items={sources.map((source) => source.id)}
      value={value || null}
      itemToStringLabel={(id: string) => names.get(id)?.name ?? id}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <ComboboxTrigger
        id={triggerId}
        aria-label={
          firstChoice
            ? t("widgets.editor.data.chooseLabel", { label })
            : t("widgets.editor.data.changeLabel", { label })
        }
        aria-describedby={describedBy}
        render={<Button type="button" variant="outline" size="sm" />}
      >
        {firstChoice
          ? t("widgets.editor.data.choose")
          : t("widgets.editor.data.change")}
      </ComboboxTrigger>
      <ComboboxContent align="end" className="w-80">
        <ComboboxInput
          showTrigger={false}
          aria-label={t("widgets.editor.data.search")}
          placeholder={t("widgets.editor.data.search")}
        />
        <ComboboxEmpty>{t("widgets.editor.data.noMatch")}</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            const source = names.get(id);
            return (
              <ComboboxItem key={id} value={id}>
                <span aria-hidden="true">
                  {source ? sourceIcon(source.provider, undefined, 16) : null}
                </span>
                <span className="grid min-w-0">
                  <span className="truncate">{source?.name ?? id}</span>
                  {source && (
                    <span className="truncate text-xs text-muted-foreground">
                      {sourceSummary(source, t)}
                    </span>
                  )}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function SampleData({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation("content");
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ["widget-data-source-preview", sourceId],
    queryFn: () => api.previewSavedDataSource(sourceId),
    enabled: open,
    retry: false,
  });
  const record = previewRecordMaps(preview.data)[0];
  const entries = Object.entries(record ?? {})
    .filter(([key, entry]) => key !== "id" && entry !== "")
    .slice(0, SAMPLE_FIELD_LIMIT);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {t("widgets.editor.data.sample")}
        <CollapsibleChevron size={14} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {preview.isLoading ? (
          <p className="text-sm text-muted-foreground">
            {t("widgets.editor.data.sampleLoading")}
          </p>
        ) : entries.length > 0 ? (
          <dl className="grid gap-1 rounded-md bg-muted p-2.5 text-sm">
            {entries.map(([key, entry]) => (
              <div key={key} className="flex min-w-0 gap-2">
                <dt className="shrink-0 font-medium">{key}</dt>
                <dd className="truncate text-muted-foreground">{entry}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            {preview.isError
              ? t("widgets.editor.data.sampleFailed")
              : t("widgets.editor.data.sampleEmpty")}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
