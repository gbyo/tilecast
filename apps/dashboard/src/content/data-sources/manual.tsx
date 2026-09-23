import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { toast } from "../../components/ui/toast";
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
import { EditorFrame } from "./shared";

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
  { value: "", label: "Empty" },
  { value: "true", label: "True" },
  { value: "false", label: "False" },
];

const manualDateModeOptions = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next_available", label: "Next available date" },
  { value: "current_week", label: "Current week" },
];

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
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<ManualSourceConfig>(
    (dataSource?.configuration as ManualSourceConfig | undefined) ?? {
      columns: [{ key: "title", label: "Title", type: "text" }],
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
      toast.add({
        title: dataSource ? "Data Source updated." : "Data Source created.",
        type: "success",
      });
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
      title={`${dataSource ? "Edit" : "Create"} Manual Table Data Source`}
      description="Maintain a small typed dataset directly in Tilecast Studio."
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <RheaButton
            type="button"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save Data Source"}
          </RheaButton>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="manual-name">Name</FieldLabel>
          <Input
            id="manual-name"
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="manual-description">Description</FieldLabel>
          <Input
            id="manual-description"
            value={description}
            disabled={readOnly}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">Columns</legend>
        {configuration.columns.map((column, index) => (
          <div
            className="grid gap-4 sm:grid-cols-3"
            key={`${column.key}-${index}`}
          >
            <Field>
              <FieldLabel htmlFor={`manual-column-key-${index}`}>
                Key
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
                Label
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
                Type
              </FieldLabel>
              <RheaSelect
                items={manualColumnTypes.map((type) => ({
                  value: type,
                  label: type,
                }))}
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
                  aria-label={`Type for ${column.label || `column ${index + 1}`}`}
                >
                  <SelectValue />
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
                  Currency
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
                <Trash2 size={15} aria-hidden="true" /> Remove
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
                    label: `Field ${current.columns.length + 1}`,
                    type: "text",
                  },
                ],
              }))
            }
          >
            <Plus size={15} aria-hidden="true" /> Add column
          </RheaButton>
        )}
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">
          Rows ({configuration.rows.length}/200)
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
                      items={booleanCellOptions}
                    >
                      <SelectTrigger
                        id={`manual-cell-${rowIndex}-${column.key}`}
                        aria-label={`${column.label} value`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {booleanCellOptions.map((option) => (
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
                  aria-label={`Remove row ${rowIndex + 1}`}
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
            <Plus size={15} aria-hidden="true" /> Add row
          </RheaButton>
        )}
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">Date-aware selection</legend>
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
          <span>Select rows from the Player&apos;s local date</span>
        </label>
        {configuration.dateSelection.enabled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="manual-date-field">Date field</FieldLabel>
              <RheaSelect
                value={configuration.dateField ?? ""}
                disabled={readOnly}
                onValueChange={(next) =>
                  setConfiguration((current) => ({
                    ...current,
                    dateField: next as string,
                  }))
                }
                items={[
                  { value: "", label: "Select a date column" },
                  ...configuration.columns
                    .filter((column) =>
                      ["date", "datetime"].includes(column.type),
                    )
                    .map((column) => ({
                      value: column.key,
                      label: column.label,
                    })),
                ]}
              >
                <SelectTrigger id="manual-date-field" aria-label="Date field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Select a date column</SelectItem>
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
              <FieldLabel htmlFor="manual-timezone">Timezone</FieldLabel>
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
              <FieldLabel htmlFor="manual-selection">Selection</FieldLabel>
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
                items={manualDateModeOptions}
              >
                <SelectTrigger id="manual-selection" aria-label="Selection">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {manualDateModeOptions.map((option) => (
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
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
