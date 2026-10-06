/**
 * Which field of the connected data fills one of the Widget's slots. The
 * suggestion comes from the slot's declared role, then its legacy keys,
 * then compatible types (suggestFieldMapping); the control says quietly
 * whether the current choice is that suggestion or the author's own.
 */
import { useQuery } from "@tanstack/react-query";
import { suggestFieldMapping } from "@tilecast/widget-kit";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { ContentDefinitionField, DataSourceField } from "@/api/types";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveDataSourceKey } from "@/content/DefinitionForm";
import { InspectorFieldFrame } from "./InspectorFieldFrame";
import {
  controlAria,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";

// Short lists read best as a plain list; long ones need search.
const SEARCH_THRESHOLD = 12;

export function useSourceFields(sourceId: string) {
  return useQuery({
    queryKey: ["definition-form-data-source", sourceId],
    queryFn: () => api.getDataSource(sourceId),
    enabled: Boolean(sourceId),
    select: (source) => source.fields ?? [],
  });
}

/** The suggested source field for a slot, or "" when nothing fits. */
export function suggestedSourceField(
  field: ContentDefinitionField,
  sourceFields: readonly DataSourceField[],
): string {
  const roles = field.ui?.semanticRole ? [field.ui.semanticRole] : [];
  const legacyKeys = field.ui?.legacyKeys ?? [];
  return (
    suggestFieldMapping([...sourceFields], {
      [field.key]: {
        roles,
        legacyKeys,
        types:
          field.ui?.typeFallback === false
            ? []
            : (field.dataSourceFieldTypes ?? []),
      },
    })[field.key] ?? ""
  );
}

/** The Data Source a mapping control reads, from its siblings or the root. */
export function mappingSourceId({
  field,
  values,
  fields,
  rootValues,
  rootFields,
}: Pick<
  InspectorFieldProps,
  "field" | "values" | "fields" | "rootValues" | "rootFields"
>) {
  const key = resolveDataSourceKey(field, fields, rootFields);
  return key ? fieldText(values[key]) || fieldText(rootValues[key]) : "";
}

export function WidgetFieldMapping(props: InspectorFieldProps) {
  const { field, path, value, onChange, readOnly, errorFor } = props;
  const { t } = useTranslation("content");
  const error = errorFor(path);
  const aria = controlAria(path, field, error);
  const sourceId = mappingSourceId(props);
  const sourceFields = useSourceFields(sourceId);
  const options = useMemo(
    () =>
      (sourceFields.data ?? [])
        .filter(
          (entry) =>
            !field.dataSourceFieldTypes?.length ||
            field.dataSourceFieldTypes.includes(entry.type),
        )
        .map((entry) => ({ value: entry.key, label: entry.label })),
    [sourceFields.data, field.dataSourceFieldTypes],
  );
  const current = fieldText(value);
  const suggestion = sourceFields.data
    ? suggestedSourceField(field, sourceFields.data)
    : "";
  const origin =
    !current || !suggestion
      ? null
      : current === suggestion
        ? t("widgets.editor.data.auto")
        : t("widgets.editor.data.custom");
  const originId = `${aria.id}-origin`;
  const describedBy =
    [aria["aria-describedby"], origin ? originId : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const disabled = readOnly || !sourceId;
  const placeholder = sourceId
    ? t("widgets.editor.fields.choose")
    : t("widgets.editor.data.chooseSourceFirst");
  const items = [
    ...(field.required
      ? []
      : [{ value: "", label: t("widgets.editor.fields.none") }]),
    ...options,
  ];

  return (
    <InspectorFieldFrame path={path} field={field} error={error}>
      <div className="flex items-center gap-2">
        {options.length > SEARCH_THRESHOLD ? (
          <MappingCombobox
            items={items}
            value={current}
            onChange={onChange}
            disabled={disabled}
            aria={{ ...aria, "aria-describedby": describedBy }}
            placeholder={placeholder}
          />
        ) : (
          <Select
            value={current}
            disabled={disabled}
            onValueChange={(next) => onChange(next ?? "")}
            items={items}
          >
            <SelectTrigger
              {...aria}
              aria-describedby={describedBy}
              className="min-w-0 flex-1"
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {items.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {origin && (
          <span
            id={originId}
            className="w-14 shrink-0 text-xs text-muted-foreground"
          >
            {origin}
          </span>
        )}
      </div>
    </InspectorFieldFrame>
  );
}

function MappingCombobox({
  items,
  value,
  onChange,
  disabled,
  aria,
  placeholder,
}: {
  items: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  aria: ReturnType<typeof controlAria>;
  placeholder: string;
}) {
  const { t } = useTranslation("content");
  const labels = new Map(items.map((item) => [item.value, item.label]));
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const values = items.map((item) => item.value);
  const filtered = values.filter((entry) =>
    (labels.get(entry) ?? entry).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Combobox
      items={values}
      filteredItems={filtered}
      value={value}
      open={open}
      disabled={disabled}
      inputValue={open ? search : (labels.get(value) ?? "")}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
      onInputValueChange={setSearch}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      itemToStringLabel={(entry: string) => labels.get(entry) ?? entry}
    >
      <ComboboxInput
        {...aria}
        className="min-w-0 flex-1"
        placeholder={placeholder}
      />
      <ComboboxContent>
        <ComboboxEmpty>{t("widgets.editor.data.noFieldMatch")}</ComboboxEmpty>
        <ComboboxList>
          {(entry: string) => (
            <ComboboxItem key={entry || "none"} value={entry}>
              {labels.get(entry) ?? entry}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
