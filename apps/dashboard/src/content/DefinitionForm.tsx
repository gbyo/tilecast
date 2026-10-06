import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { suggestFieldMapping } from "@tilecast/widget-kit";
import { Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type {
  Asset,
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
  DataSourceField,
} from "../api/types";
import { ContentPicker } from "../components/content-picker";
import { DateInput, DateTimeInput } from "../components/date-picker";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  localDateTimeToRfc3339,
  rfc3339ToLocalDateTime,
} from "../lib/dateTime";
import { useStableRowIds } from "../components/content/widget-editor/fields/rowIdentity";
import { DataSourcePicker } from "./DataSourcePicker";
import {
  compatibleSources,
  creatableProviders,
  dataFormatGuideFor,
  resolveDataSourceKey,
} from "./dataSourceBindings";

type Values = Record<string, unknown>;

function fieldText(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function DefinitionForm({
  fields,
  value,
  onChange,
  readOnly = false,
  csrf,
  rootValues,
  rootFields,
}: {
  fields: ContentDefinitionField[];
  value: Values;
  onChange: (value: Values) => void;
  readOnly?: boolean;
  csrf?: string;
  /**
   * The outermost configuration. Repeating-group items render a nested
   * form whose own values cannot name the Data Source, so field pickers
   * inside a group resolve against these root values instead.
   */
  rootValues?: Values;
  /** The outermost schema; nested keyless fields fall back to its single source. */
  rootFields?: ContentDefinitionField[];
}) {
  const root = rootValues ?? value;
  const rootSchema = rootFields ?? fields;
  const needsDataSources = fields.some(
    (field) =>
      field.control === "data_source" || field.control === "data_source_field",
  );
  const dataSources = useQuery({
    queryKey: ["definition-form-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled: needsDataSources,
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const set = (key: string, next: unknown) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="grid gap-4">
      {fields.map((field) => (
        <DefinitionControl
          key={field.key}
          field={field}
          fields={fields}
          values={value}
          rootValues={root}
          rootFields={rootSchema}
          value={value[field.key]}
          setValue={(next) => set(field.key, next)}
          readOnly={readOnly}
          csrf={csrf}
          dataSources={dataSources.data?.items ?? []}
          dataSourceDefinitions={definitions.data?.dataSources ?? []}
        />
      ))}
    </div>
  );
}

// RepeatingGroupControl keeps each item's inputs with that item while others
// are added or removed, through editor-local row identity (never saved).
function RepeatingGroupControl({
  field,
  labelText,
  value,
  setValue,
  readOnly,
  csrf,
  rootValues,
  rootFields,
}: {
  field: ContentDefinitionField;
  labelText: string;
  value: unknown;
  setValue: (value: unknown) => void;
  readOnly: boolean;
  csrf?: string;
  rootValues: Values;
  rootFields: ContentDefinitionField[];
}) {
  const { t } = useTranslation(["content", "common"]);
  const items = Array.isArray(value) ? (value as Values[]) : [];
  const rows = useStableRowIds(items.length);
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">{labelText}</legend>
      {items.map((item, index) => (
        <div className="grid gap-3 rounded-lg border p-3" key={rows.ids[index]}>
          <DefinitionForm
            fields={field.itemFields ?? []}
            value={item}
            readOnly={readOnly}
            csrf={csrf}
            rootValues={rootValues}
            rootFields={rootFields}
            onChange={(next) =>
              setValue(
                items.map((current, currentIndex) =>
                  currentIndex === index ? next : current,
                ),
              )
            }
          />
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("widgets.form.removeItem", {
                label: field.label,
                index: index + 1,
              })}
              onClick={() => {
                rows.removeAt(index);
                setValue(items.filter((_, current) => current !== index));
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && items.length < (field.maximumItems ?? 0) && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            rows.append();
            setValue([...items, {}]);
          }}
        >
          <Plus size={15} aria-hidden="true" /> {t("widgets.form.addItem")}
        </Button>
      )}
    </fieldset>
  );
}

const pickerAssetTypes = ["image", "video", "widget"] as const;

// MediaAssetControl selects through the searchable, paginated Media picker
// instead of a fixed first-page snapshot, so every eligible asset stays
// reachable no matter how large the library grows. The current selection
// resolves by ID for display.
function MediaAssetControl({
  field,
  labelText,
  value,
  setValue,
  readOnly,
  csrf,
}: {
  field: ContentDefinitionField;
  labelText: string;
  value: unknown;
  setValue: (value: unknown) => void;
  readOnly: boolean;
  csrf?: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const id = fieldText(value);
  const current = useQuery({
    queryKey: ["asset", id],
    queryFn: () => api.asset(id),
    enabled: Boolean(id),
  });
  const allowedTypes = field.mediaTypes?.length
    ? field.mediaTypes.filter(
        (type): type is (typeof pickerAssetTypes)[number] =>
          (pickerAssetTypes as readonly string[]).includes(type),
      )
    : undefined;
  return (
    <Field>
      <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
      <div className="flex items-center gap-2">
        <Button
          id={`definition-${field.key}`}
          type="button"
          variant="outline"
          aria-label={labelText}
          disabled={readOnly}
          onClick={() => setPickerOpen(true)}
          className="min-w-0 flex-1 justify-start truncate"
        >
          {current.data?.name ??
            (current.isError ? id : t("widgets.form.mediaAsset.none"))}
        </Button>
        {id && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("widgets.form.mediaAsset.clear")}
            onClick={() => setValue("")}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <ContentPicker
        open={pickerOpen}
        mode="single"
        csrf={csrf ?? ""}
        allowedTypes={allowedTypes}
        selectedIds={id ? [id] : []}
        title={t("widgets.form.mediaAsset.pickerTitle")}
        description={t("widgets.form.mediaAsset.pickerDescription")}
        confirmLabel={t("widgets.form.mediaAsset.pickerConfirm")}
        onConfirm={(items: Asset[]) => {
          setValue(items[0]?.id ?? "");
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
      {field.description && (
        <FieldDescription>{field.description}</FieldDescription>
      )}
    </Field>
  );
}

function DefinitionControl({
  field,
  fields,
  values,
  rootValues,
  rootFields,
  value,
  setValue,
  readOnly,
  csrf,
  dataSources,
  dataSourceDefinitions,
}: {
  field: ContentDefinitionField;
  fields: ContentDefinitionField[];
  values: Values;
  /** The outermost configuration; nested items resolve pickers against it. */
  rootValues: Values;
  rootFields: ContentDefinitionField[];
  value: unknown;
  setValue: (value: unknown) => void;
  readOnly: boolean;
  csrf?: string;
  dataSources: DataSource[];
  dataSourceDefinitions: DataSourceDefinition[];
}) {
  const { t } = useTranslation(["content", "common"]);
  // A field picker resolves against the source chosen by its own `data_source` control, not a
  // hardcoded `dataSourceId`, so a definition may reference several Data Sources.
  // Nested items pass their itemFields as `fields` with the root schema as
  // `rootFields`, so a keyless nested picker falls back to the root source.
  const fieldSourceKey =
    field.control === "data_source_field"
      ? resolveDataSourceKey(field, fields, rootFields)
      : undefined;
  const fieldSourceID = fieldSourceKey
    ? fieldText(values[fieldSourceKey]) || fieldText(rootValues[fieldSourceKey])
    : "";
  const fieldSource = useQuery({
    queryKey: ["definition-form-data-source", fieldSourceID],
    queryFn: () => api.getDataSource(fieldSourceID),
    enabled: Boolean(fieldSourceID),
  });
  // Automatic semantic mapping (§4.1): when a source is connected, an empty
  // field picker fills from declared roles, then legacy keys, then
  // compatible types. The author may override every mapping in the picker.
  const suggestedField = useMemo(() => {
    if (field.control !== "data_source_field") return "";
    const roles = field.ui?.semanticRole ? [field.ui.semanticRole] : [];
    const legacyKeys = field.ui?.legacyKeys ?? [];
    if (roles.length === 0 && legacyKeys.length === 0) return "";
    const sourceFields = fieldSource.data?.fields;
    if (!sourceFields) return "";
    return (
      suggestFieldMapping(sourceFields, {
        [field.key]: {
          roles,
          legacyKeys,
          types: field.dataSourceFieldTypes ?? [],
        },
      })[field.key] ?? ""
    );
  }, [field, fieldSource.data]);
  const lastSuggestedSource = useRef("");
  useEffect(() => {
    if (field.control !== "data_source_field" || readOnly) return;
    if (!fieldSourceID || !fieldSource.data) {
      lastSuggestedSource.current = "";
      return;
    }
    const current = fieldText(value);
    const freshSource = lastSuggestedSource.current !== fieldSourceID;
    lastSuggestedSource.current = fieldSourceID;
    const known = new Set(
      (fieldSource.data.fields ?? []).map((entry) => entry.key),
    );
    // An author choice for this source stands. A key the new source does
    // not have is stale from a previous source, so it remaps.
    if (current !== "" && (!freshSource || known.has(current))) return;
    if (suggestedField !== "" && suggestedField !== current)
      setValue(suggestedField);
  }, [
    field,
    fieldSourceID,
    fieldSource.data,
    suggestedField,
    value,
    readOnly,
    setValue,
  ]);
  const common = {
    disabled: readOnly,
    required: field.required,
  };
  const requiredMark = field.required ? " *" : "";
  const labelText = `${field.label}${requiredMark}`;
  if (field.control === "currency_code")
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>
          {t("dataSources.manual.currency")}
        </FieldLabel>
        <Input
          id={`definition-${field.key}`}
          {...common}
          value={fieldText(value).toUpperCase()}
          maxLength={3}
          autoCapitalize="characters"
          onChange={(event) => setValue(event.target.value.toUpperCase())}
        />
        <FieldDescription>
          {t("dataSources.manual.currencyHint")}
        </FieldDescription>
      </Field>
    );
  if (field.control === "data_source")
    return (
      <DataSourcePicker
        label={field.label}
        description={field.description}
        value={fieldText(value)}
        sources={compatibleSources(field, dataSources, dataSourceDefinitions)}
        createProviders={creatableProviders(field, dataSourceDefinitions)}
        formatGuide={dataFormatGuideFor(field, fields, t)}
        csrf={csrf}
        disabled={readOnly}
        required={field.required}
        onChange={setValue}
      />
    );
  if (field.control === "boolean")
    // The wrapping label names the switch; the span carries the label text
    // alone so the accessible name stays exact, with no extra aria-label.
    return (
      <Field>
        <FieldLabel className="flex items-center gap-2 text-sm">
          <Switch
            checked={!!value}
            disabled={readOnly}
            onCheckedChange={(checked) => setValue(checked === true)}
          />
          <span>{labelText}</span>
        </FieldLabel>
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  if (field.control === "multiline_text")
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
        <Textarea
          id={`definition-${field.key}`}
          {...common}
          value={fieldText(value)}
          maxLength={field.maxLength}
          onChange={(event) => setValue(event.target.value)}
        />
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  if (field.control === "media_asset")
    return (
      <MediaAssetControl
        field={field}
        labelText={labelText}
        value={value}
        setValue={setValue}
        readOnly={readOnly}
        csrf={csrf}
      />
    );
  if (field.control === "select" || field.control === "data_source_field") {
    const options =
      field.control === "select"
        ? (field.options ?? [])
        : (fieldSource.data?.fields ?? [])
            .filter(
              (sourceField: DataSourceField) =>
                !field.dataSourceFieldTypes?.length ||
                field.dataSourceFieldTypes.includes(sourceField.type),
            )
            .map((sourceField: DataSourceField) => ({
              value: sourceField.key,
              label: `${sourceField.label} (${sourceField.type})`,
            }));
    const placeholder =
      field.control === "data_source_field" && !fieldSourceID
        ? t("widgets.form.selectSourceFirst")
        : t("widgets.form.selectPlaceholder");
    const labeledOptions = [{ value: "", label: placeholder }, ...options];
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
        <Select
          value={fieldText(value)}
          disabled={readOnly}
          required={field.required}
          onValueChange={(next) => setValue(next)}
          items={labeledOptions}
        >
          <SelectTrigger id={`definition-${field.key}`} aria-label={labelText}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {labeledOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  }
  if (field.control === "repeating_group")
    return (
      <RepeatingGroupControl
        field={field}
        labelText={labelText}
        value={value}
        setValue={setValue}
        readOnly={readOnly}
        csrf={csrf}
        rootValues={rootValues}
        rootFields={rootFields}
      />
    );
  if (field.control === "date")
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
        <DateInput
          id={`definition-${field.key}`}
          {...common}
          aria-label={labelText}
          value={fieldText(value)}
          onChange={setValue}
        />
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  if (field.control === "datetime")
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
        <DateTimeInput
          id={`definition-${field.key}`}
          {...common}
          aria-label={labelText}
          value={rfc3339ToLocalDateTime(fieldText(value))}
          onChange={(next) => setValue(localDateTimeToRfc3339(next))}
        />
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  if (field.control === "local_datetime")
    // A wall-clock time that a sibling timezone field interprets: it is
    // shown and saved exactly as entered, never converted to an instant.
    // A saved RFC 3339 instant from an older release shows as its own
    // wall time until it is edited.
    return (
      <Field>
        <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
        <DateTimeInput
          id={`definition-${field.key}`}
          {...common}
          aria-label={labelText}
          value={fieldText(value).slice(0, 16)}
          onChange={setValue}
        />
        {field.description && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  const inputType =
    field.control === "number" || field.control === "integer"
      ? "number"
      : field.control === "color"
        ? "color"
        : field.control === "url"
          ? "url"
          : "text";
  return (
    <Field>
      <FieldLabel htmlFor={`definition-${field.key}`}>{labelText}</FieldLabel>
      <Input
        id={`definition-${field.key}`}
        {...common}
        type={inputType}
        value={fieldText(value)}
        min={field.minimum}
        max={field.maximum}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(event) =>
          setValue(
            field.control === "number" || field.control === "integer"
              ? event.target.value === ""
                ? undefined
                : Number(event.target.value)
              : event.target.value,
          )
        }
      />
      {field.description && (
        <FieldDescription>{field.description}</FieldDescription>
      )}
    </Field>
  );
}
