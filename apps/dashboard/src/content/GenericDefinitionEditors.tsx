import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type {
  DataSourceDefinition,
  DataSourceDetail,
  SavedDataSource,
} from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import { apiErrorMessage } from "../i18n";
import { initialDataSourceConfiguration } from "./dataSourceDefaults";
import {
  isISO4217CurrencyCode,
  useOrganizationRegionalProfile,
} from "../settings/regionalProfile";
import { DefinitionForm } from "./DefinitionForm";

// The generic Data Source editor. Widgets author in the Widget editor
// (components/content/widget-editor); this shell serves Data Sources only.
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
  onSaved: (source: SavedDataSource) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const regional = useOrganizationRegionalProfile();
  const [name, setName] = useState(dataSource?.name ?? definition.name);
  const [description, setDescription] = useState(
    dataSource?.description ?? definition.description,
  );
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    dataSource?.configuration ?? initialDataSourceConfiguration(definition),
  );
  useEffect(() => {
    if (
      dataSource ||
      definition.id !== "public-holidays" ||
      !regional.ready ||
      !regional.region
    ) {
      return;
    }
    setConfiguration((current) =>
      typeof current.countryCode === "string" && current.countryCode.trim()
        ? current
        : { ...current, countryCode: regional.region },
    );
  }, [dataSource, definition.id, regional.ready, regional.region]);
  const missingHolidayCountry =
    definition.id === "public-holidays" &&
    !(
      typeof configuration.countryCode === "string" &&
      configuration.countryCode.trim()
    );
  const missingMenuCurrency =
    !dataSource &&
    definition.id === "menu-items" &&
    !isISO4217CurrencyCode(
      typeof configuration.priceCurrency === "string"
        ? configuration.priceCurrency
        : "",
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
      saveDisabled={missingHolidayCountry || missingMenuCurrency}
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
  children: ReactNode;
}) {
  const { t } = useTranslation(["content", "common"]);
  const nameId = useId();
  const detailId = useId();
  return (
    <section
      className="source-editor grid gap-4"
      aria-labelledby="definition-editor-title"
    >
      <header className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div className="grid gap-1">
          <h2 id="definition-editor-title" className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" onClick={onClose}>
          {t("common:actions.close")}
        </Button>
      </header>
      <div className="source-editor__body">
        <div className="form-grid">
          <Field>
            <FieldLabel htmlFor={nameId}>
              {t("widgets.editors.generic.dataSourceName")}
            </FieldLabel>
            <Input
              id={nameId}
              value={name}
              disabled={readOnly}
              maxLength={180}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>
              {t("widgets.editors.generic.dataSourceNameHint")}
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
        {children}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(error)}</AlertDescription>
          </Alert>
        )}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button variant="outline" onClick={onClose}>
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
  );
}
