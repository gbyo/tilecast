import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import {
  Controller,
  useController,
  type Control,
  type FieldPathByValue,
  type FieldValues,
} from "react-hook-form";
import { api } from "../api/client";
import { Checkbox } from "../components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const targetScopeOptions = [
  { value: "all", label: "All screens" },
  { value: "screens", label: "Individual screens" },
  { value: "sync_groups", label: "Display Groups" },
  { value: "locations", label: "Locations" },
];

/** Base Vega checkbox connected to a typed React Hook Form field. */
export function RegisterCheckbox<TForm extends FieldValues>({
  control,
  name,
  label,
  disabled,
}: {
  control: Control<TForm>;
  name: FieldPathByValue<TForm, boolean>;
  label: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Field
          data-disabled={disabled}
          orientation="horizontal"
          className="items-center"
        >
          <Checkbox
            id={id}
            name={field.name}
            checked={field.value === true}
            disabled={disabled}
            onCheckedChange={(checked) => field.onChange(checked === true)}
            onBlur={field.onBlur}
          />
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
        </Field>
      )}
    />
  );
}

export type TargetScope = "all" | "screens" | "sync_groups" | "locations";

export function canManage(role?: string) {
  return role === "owner" || role === "administrator";
}

/**
 * `datetime-local` inputs carry no zone, and the submit path reads them back
 * with `new Date(value)` — the browser's own zone. Formatting the stored
 * instant the same way keeps the round trip stable instead of shifting the
 * target by the browser's UTC offset on every edit.
 */
export function toLocalInputValue(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Targeting is identical for every plugin, so the scopes, the picker, and its
 * loading, failed, and genuinely-empty wording live here once rather than being
 * copied per editor.
 */
export interface TargetSource {
  query: {
    data?: { items: { id: string; name: string }[] };
    isLoading: boolean;
    isError: boolean;
  };
  noun: string;
  empty: string;
}

export function useTargetSource(scope: TargetScope): TargetSource | null {
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    enabled: scope === "screens",
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
    enabled: scope === "sync_groups",
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled: scope === "locations",
  });
  return scope === "screens"
    ? { query: screens, noun: "screens", empty: "No screens are enrolled yet." }
    : scope === "sync_groups"
      ? {
          query: groups,
          noun: "Display Groups",
          empty: "No Display Groups exist yet.",
        }
      : scope === "locations"
        ? {
            query: locations,
            noun: "locations",
            empty: "No locations exist yet.",
          }
        : null;
}

export function TargetFields<TForm extends FieldValues>({
  idPrefix,
  scope,
  source,
  error,
  control,
  onScopeChange,
}: {
  idPrefix: string;
  scope: TargetScope;
  source: TargetSource | null;
  error?: string;
  control: Control<TForm>;
  onScopeChange: (value: TargetScope) => void;
}) {
  const targetIds = useController({
    control,
    name: "targetIds" as FieldPathByValue<TForm, string[]>,
  });
  const selectedIds = Array.isArray(targetIds.field.value)
    ? (targetIds.field.value as string[])
    : [];
  const errorId = `${idPrefix}-targets-error`;
  const targets = (source?.query.data?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-target-scope`}>
          Target type
        </FieldLabel>
        <Select
          items={targetScopeOptions}
          name="targetScope"
          value={scope}
          onValueChange={(next) => {
            if (next) onScopeChange(next);
          }}
        >
          <SelectTrigger
            id={`${idPrefix}-target-scope`}
            aria-label="Target type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {targetScopeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {source && (
        <FieldSet
          className="grid gap-2 rounded-xl border border-border p-3"
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
        >
          <FieldLegend
            variant="label"
            className="mb-0 flex w-full items-center justify-between gap-2"
          >
            <span>Choose targets</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {selectedIds.length} of {targets.length} selected
            </span>
          </FieldLegend>
          <FieldDescription>Available {source.noun}</FieldDescription>
          <div className="grid max-h-56 gap-1 overflow-auto">
            {targets.map((target) => {
              const targetId = `${idPrefix}-target-${target.id}`;
              const checked = selectedIds.includes(target.id);
              return (
                <Field
                  key={target.id}
                  orientation="horizontal"
                  className="items-center rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    id={targetId}
                    value={target.id}
                    checked={checked}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    onBlur={targetIds.field.onBlur}
                    onCheckedChange={(nextChecked) => {
                      const next = nextChecked
                        ? [...selectedIds, target.id]
                        : selectedIds.filter((id) => id !== target.id);
                      targetIds.field.onChange(next);
                    }}
                  />
                  <FieldLabel htmlFor={targetId} className="flex-1 font-normal">
                    {target.name}
                  </FieldLabel>
                </Field>
              );
            })}
            {!targets.length && (
              <p className="text-sm text-muted-foreground">
                {source.query.isLoading
                  ? `Loading ${source.noun}…`
                  : source.query.isError
                    ? `The ${source.noun} could not be loaded.`
                    : source.empty}
              </p>
            )}
          </div>
          {error && <FieldError id={errorId}>{error}</FieldError>}
        </FieldSet>
      )}
    </>
  );
}
