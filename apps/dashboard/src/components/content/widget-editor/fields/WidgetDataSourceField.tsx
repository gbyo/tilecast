/**
 * The data behind a Widget, shown as a connected resource rather than an
 * opaque value: its name, kind, health, and size, with a searchable way to
 * change it and a way to connect new data without leaving the draft.
 * Compatibility (accepted kinds, required fields) is the definition's.
 */
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { DataSourceProvider } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { contentQueries } from "@/data/content";
import { ConnectDataFlow } from "@/content/DataSourceCreateFlow";
import { DataFormatGuidePanel } from "@/content/DataSourcePicker";
import {
  compatibleSources,
  creatableProviders,
  dataFormatGuideFor,
} from "@/content/dataSourceBindings";
import { galleryHiddenProviders } from "@/content/dataSourceProviderMeta";
import { useDataSourceLibrary } from "./dataSourceLibrary";
import { SampleData, SelectedSource, SourceChooser } from "./DataSourceParts";
import {
  fieldDomId,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";

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
      <SelectedSource
        labelId={`${id}-label`}
        selected={selected}
        missing={missing}
        loading={library.isLoading}
        compatibleCount={sources.length}
        chooser={chooser}
      />
      {canConnect && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
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
