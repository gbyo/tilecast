import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button as RheaButton } from "../../components/ui/button";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch as RheaSwitch } from "../../components/ui/switch";
import type {
  DataSourceDetail,
  DateSelection,
  ManualColumn,
  ManualSourceConfig,
} from "../../api/types";
import { EditorFrame, optionLabel } from "./shared";

const manualColumnTypes = [
  "text",
  "number",
  "integer",
  "percent",
  "currency",
  "boolean",
  "date",
  "datetime",
  "url",
];

const booleanCellOptions = [
  { value: "", labelKey: "sources.manual.booleanEmpty" },
  { value: "true", labelKey: "sources.manual.booleanTrue" },
  { value: "false", labelKey: "sources.manual.booleanFalse" },
] as const;

const manualDateModeOptions = [
  { value: "today", labelKey: "sources.manual.modeToday" },
  { value: "tomorrow", labelKey: "sources.manual.modeTomorrow" },
  { value: "next_available", labelKey: "sources.manual.modeNextAvailable" },
  { value: "current_week", labelKey: "sources.manual.modeCurrentWeek" },
] as const;

export function ManualDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["content", "common"]);
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const booleanOptions = booleanCellOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const dateModeOptions = manualDateModeOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const [configuration, setConfiguration] = useState<ManualSourceConfig>(
    (dataSource?.configuration as ManualSourceConfig | undefined) ?? {
      columns: [
        {
          key: "title",
          label: t("sources.manual.defaultColumnLabel"),
          type: "text",
        },
      ],
      rows: [{ id: crypto.randomUUID(), values: { title: "" } }],
      dateSelection: {
        enabled: false,
        dateFormat: "auto",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        mode: "today",
        excludePast: false,
        noMatchBehavior: "empty",
      },
    },
  );
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "manual" as const,
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
  const updateColumn = (index: number, patch: Partial<ManualColumn>) =>
    setConfiguration((current) => ({
      ...current,
      columns: current.columns.map((column, columnIndex) =>
        columnIndex === index ? { ...column, ...patch } : column,
      ),
    }));
  return (
    <EditorFrame
      title={t(
        dataSource ? "sources.manual.editTitle" : "sources.manual.createTitle",
      )}
      description={t("sources.manual.frameDescription")}
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <RheaButton
            type="button"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? t("common:actions.saving")
              : t("sources.shared.saveDataSource")}
          </RheaButton>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="manual-name">
            {t("sources.shared.name")}
          </FieldLabel>
          <Input
            id="manual-name"
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="manual-description">
            {t("sources.shared.description")}
          </FieldLabel>
          <Input
            id="manual-description"
            value={description}
            disabled={readOnly}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">
          {t("sources.manual.columnsLegend")}
        </legend>
        {configuration.columns.map((column, index) => (
          <div
            className="grid gap-4 sm:grid-cols-3"
            key={`${column.key}-${index}`}
          >
            <Field>
              <FieldLabel htmlFor={`manual-column-key-${index}`}>
                {t("sources.manual.keyLabel")}
              </FieldLabel>
              <Input
                id={`manual-column-key-${index}`}
                value={column.key}
                disabled={readOnly}
                onChange={(event) =>
                  updateColumn(index, { key: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`manual-column-label-${index}`}>
                {t("sources.manual.labelLabel")}
              </FieldLabel>
              <Input
                id={`manual-column-label-${index}`}
                value={column.label}
                disabled={readOnly}
                onChange={(event) =>
                  updateColumn(index, { label: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`manual-column-type-${index}`}>
                {t("sources.manual.typeLabel")}
              </FieldLabel>
              <RheaSelect
                value={column.type}
                disabled={readOnly}
                onValueChange={(next) =>
                  updateColumn(index, {
                    type: next as ManualColumn["type"],
                  })
                }
              >
                <SelectTrigger
                  id={`manual-column-type-${index}`}
                  aria-label={t("sources.manual.typeForColumn", {
                    label:
                      column.label ||
                      t("sources.manual.columnNumber", { index: index + 1 }),
                  })}
                >
                  <SelectValue>{column.type}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {manualColumnTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            {column.type === "currency" && (
              <Field>
                <FieldLabel htmlFor={`manual-column-currency-${index}`}>
                  {t("sources.manual.currencyLabel")}
                </FieldLabel>
                <Input
                  id={`manual-column-currency-${index}`}
                  value={column.currency ?? "USD"}
                  maxLength={3}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateColumn(index, {
                      currency: event.target.value.toUpperCase(),
                    })
                  }
                />
              </Field>
            )}
            {!readOnly && configuration.columns.length > 1 && (
              <RheaButton
                type="button"
                variant="destructive"
                onClick={() =>
                  setConfiguration((current) => ({
                    ...current,
                    columns: current.columns.filter((_, i) => i !== index),
                    rows: current.rows.map((row) => {
                      const values = { ...row.values };
                      delete values[column.key];
                      return { ...row, values };
                    }),
                  }))
                }
              >
                <Trash2 size={15} aria-hidden="true" />{" "}
                {t("common:actions.remove")}
              </RheaButton>
            )}
          </div>
        ))}
        {!readOnly && configuration.columns.length < 12 && (
          <RheaButton
            type="button"
            variant="outline"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                columns: [
                  ...current.columns,
                  {
                    key: `field_${current.columns.length + 1}`,
                    label: t("sources.manual.newColumnLabel", {
                      index: current.columns.length + 1,
                    }),
                    type: "text",
                  },
                ],
              }))
            }
          >
            <Plus size={15} aria-hidden="true" />{" "}
            {t("sources.manual.addColumn")}
          </RheaButton>
        )}
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">
          {t("sources.manual.rowsLegend", {
            count: configuration.rows.length,
          })}
        </legend>
        <div className="grid gap-3">
          {configuration.rows.map((row, rowIndex) => (
            <div
              className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2"
              key={row.id}
            >
              {configuration.columns.map((column) => (
                <Field key={column.key}>
                  <FieldLabel htmlFor={`manual-cell-${rowIndex}-${column.key}`}>
                    {column.label}
                  </FieldLabel>
                  {column.type === "boolean" ? (
                    <RheaSelect
                      value={row.values[column.key] ?? ""}
                      disabled={readOnly}
                      onValueChange={(next) =>
                        setConfiguration((current) => ({
                          ...current,
                          rows: current.rows.map((item, index) =>
                            index === rowIndex
                              ? {
                                  ...item,
                                  values: {
                                    ...item.values,
                                    [column.key]: next as string,
                                  },
                                }
                              : item,
                          ),
                        }))
                      }
                    >
                      <SelectTrigger
                        id={`manual-cell-${rowIndex}-${column.key}`}
                        aria-label={t("sources.manual.cellValue", {
                          label: column.label,
                        })}
                      >
                        <SelectValue>
                          {optionLabel(
                            booleanOptions,
                            row.values[column.key] ?? "",
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {booleanOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </RheaSelect>
                  ) : (
                    <Input
                      id={`manual-cell-${rowIndex}-${column.key}`}
                      type={
                        column.type === "date"
                          ? "date"
                          : column.type === "datetime"
                            ? "text"
                            : [
                                  "number",
                                  "integer",
                                  "percent",
                                  "currency",
                                ].includes(column.type)
                              ? "number"
                              : "text"
                      }
                      value={row.values[column.key] ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          rows: current.rows.map((item, index) =>
                            index === rowIndex
                              ? {
                                  ...item,
                                  values: {
                                    ...item.values,
                                    [column.key]: event.target.value,
                                  },
                                }
                              : item,
                          ),
                        }))
                      }
                    />
                  )}
                </Field>
              ))}
              {!readOnly && (
                <RheaButton
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("sources.manual.removeRow", {
                    index: rowIndex + 1,
                  })}
                  onClick={() =>
                    setConfiguration((current) => ({
                      ...current,
                      rows: current.rows.filter(
                        (_, index) => index !== rowIndex,
                      ),
                    }))
                  }
                >
                  <Trash2 size={15} aria-hidden="true" />
                </RheaButton>
              )}
            </div>
          ))}
        </div>
        {!readOnly && configuration.rows.length < 200 && (
          <RheaButton
            type="button"
            variant="outline"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                rows: [
                  ...current.rows,
                  { id: crypto.randomUUID(), values: {} },
                ],
              }))
            }
          >
            <Plus size={15} aria-hidden="true" /> {t("sources.manual.addRow")}
          </RheaButton>
        )}
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">
          {t("sources.manual.dateSelection")}
        </legend>
        {/* The wrapping label names the switch; no extra aria-label. */}
        <label className="flex items-center gap-2 text-sm">
          <RheaSwitch
            checked={configuration.dateSelection.enabled}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              setConfiguration((current) => ({
                ...current,
                dateSelection: {
                  ...current.dateSelection,
                  enabled: checked === true,
                },
              }))
            }
          />
          <span>{t("sources.manual.selectByDate")}</span>
        </label>
        {configuration.dateSelection.enabled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="manual-date-field">
                {t("sources.manual.dateField")}
              </FieldLabel>
              <RheaSelect
                value={configuration.dateField ?? ""}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateField: next as string,
                  }))
                }
              >
                <SelectTrigger
                  id="manual-date-field"
                  aria-label={t("sources.manual.dateField")}
                >
                  <SelectValue>
                    {optionLabel(
                      [
                        {
                          value: "",
                          label: t("sources.manual.selectDateColumn"),
                        },
                        ...configuration.columns
                          .filter((column) =>
                            ["date", "datetime"].includes(column.type),
                          )
                          .map((column) => ({
                            value: column.key,
                            label: column.label,
                          })),
                      ],
                      configuration.dateField ?? "",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    {t("sources.manual.selectDateColumn")}
                  </SelectItem>
                  {configuration.columns
                    .filter((column) =>
                      ["date", "datetime"].includes(column.type),
                    )
                    .map((column) => (
                      <SelectItem key={column.key} value={column.key}>
                        {column.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-timezone">
                {t("sources.manual.timezone")}
              </FieldLabel>
              <Input
                id="manual-timezone"
                value={configuration.dateSelection.timezone}
                disabled={readOnly}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateSelection: {
                      ...current.dateSelection,
                      timezone: event.target.value,
                    },
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-selection">
                {t("sources.manual.selection")}
              </FieldLabel>
              <RheaSelect
                value={configuration.dateSelection.mode}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateSelection: {
                      ...current.dateSelection,
                      mode: next as DateSelection["mode"],
                    },
                  }))
                }
              >
                <SelectTrigger
                  id="manual-selection"
                  aria-label={t("sources.manual.selection")}
                >
                  <SelectValue>
                    {optionLabel(
                      dateModeOptions,
                      configuration.dateSelection.mode,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {dateModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
        )}
      </fieldset>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
