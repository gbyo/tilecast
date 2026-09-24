import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import {
  Controller,
  useController,
  type Control,
  type FieldPathByValue,
  type FieldValues,
} from "react-hook-form";
import { useTranslation } from "react-i18next";
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
import type { PluginsT } from "./pluginCatalog";

const targetScopeOptions = [
  { value: "all", labelKey: "shared.scope.all" },
  { value: "screens", labelKey: "shared.scope.screens" },
  { value: "sync_groups", labelKey: "shared.scope.syncGroups" },
  { value: "locations", labelKey: "shared.scope.locations" },
] as const;

export function targetScopeLabel(value: TargetScope, t: PluginsT) {
  const found = targetScopeOptions.find((option) => option.value === value);
  return found ? t(found.labelKey) : value;
}

/** Weekday toggle labels, keyed by the numeric scheduleWeekdays value. */
const weekdayShortKeys = {
  0: "weekdays.sunday.short",
  1: "weekdays.monday.short",
  2: "weekdays.tuesday.short",
  3: "weekdays.wednesday.short",
  4: "weekdays.thursday.short",
  5: "weekdays.friday.short",
  6: "weekdays.saturday.short",
} as const;

export function weekdayShortLabel(value: number, t: PluginsT) {
  const key =
    weekdayShortKeys[value as keyof typeof weekdayShortKeys] ??
    weekdayShortKeys[0];
  return t(key);
}

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
  const { t } = useTranslation("plugins");
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
    ? {
        query: screens,
        noun: t("shared.nouns.screens"),
        empty: t("shared.empty.screens"),
      }
    : scope === "sync_groups"
      ? {
          query: groups,
          noun: t("shared.nouns.syncGroups"),
          empty: t("shared.empty.syncGroups"),
        }
      : scope === "locations"
        ? {
            query: locations,
            noun: t("shared.nouns.locations"),
            empty: t("shared.empty.locations"),
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
  const { t } = useTranslation("plugins");
  const targetIds = useController({
    control,
    name: "targetIds" as FieldPathByValue<TForm, string[]>,
  });
  const selectedIds = Array.isArray(targetIds.field.value)
    ? (targetIds.field.value as string[])
    : [];
  const errorId = idPrefix + "-targets-error";
  const targets = (source?.query.data?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
  return (
    <>
      <Field>
        <FieldLabel htmlFor={idPrefix + "-target-scope"}>
          {t("shared.targetType")}
        </FieldLabel>
        <Select
          items={targetScopeOptions.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
          name="targetScope"
          value={scope}
          onValueChange={(next) => {
            if (next) onScopeChange(next);
          }}
        >
          <SelectTrigger
            id={idPrefix + "-target-scope"}
            aria-label={t("shared.targetType")}
          >
            <SelectValue>{targetScopeLabel(scope, t)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {targetScopeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
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
            id={idPrefix + "-targets-label"}
            variant="label"
            className="mb-0 flex w-full items-center justify-between gap-2"
          >
            <span>{t("shared.chooseTargets")}</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {t("shared.selectedCount", {
                chosen: selectedIds.length,
                total: targets.length,
              })}
            </span>
          </FieldLegend>
          <FieldDescription>
            {t("shared.available", { noun: source.noun })}
          </FieldDescription>
          <div className="grid max-h-56 gap-1 overflow-auto">
            {targets.map((target) => {
              const targetId = idPrefix + "-target-" + target.id;
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
                  ? t("shared.loadingNoun", { noun: source.noun })
                  : source.query.isError
                    ? t("shared.loadErrorNoun", { noun: source.noun })
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
