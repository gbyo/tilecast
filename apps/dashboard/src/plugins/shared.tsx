import { useQuery } from "@tanstack/react-query";
import type { InputHTMLAttributes } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import {
  Select as RheaSelect,
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

/** Wrapping-label native checkbox for react-hook-form register() spreads. */
export function RegisterCheckbox({
  label,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      {/* Native input: register() attaches an uncontrolled ref. */}
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        {...input}
      />
      <span>{label}</span>
    </label>
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

export function TargetFields({
  idPrefix,
  scope,
  source,
  chosenCount,
  error,
  registerTargetIds,
  onScopeChange,
}: {
  idPrefix: string;
  scope: TargetScope;
  source: TargetSource | null;
  chosenCount: number;
  error?: string;
  registerTargetIds: UseFormRegisterReturn;
  onScopeChange: (value: TargetScope) => void;
}) {
  const { t } = useTranslation("plugins");
  const targets = (source?.query.data?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-target-scope`}>
          {t("shared.targetType")}
        </FieldLabel>
        <RheaSelect
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
            id={`${idPrefix}-target-scope`}
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
        </RheaSelect>
      </Field>
      {source && (
        <div className="grid gap-2">
          <span
            className="text-sm font-medium"
            id={`${idPrefix}-targets-label`}
          >
            {t("shared.chooseTargets")}
          </span>
          <div
            className="grid gap-2 rounded-xl border border-border p-3"
            role="group"
            aria-labelledby={`${idPrefix}-targets-label`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                {t("shared.available", { noun: source.noun })}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("shared.selectedCount", {
                  chosen: chosenCount,
                  total: targets.length,
                })}
              </span>
            </div>
            <div className="grid max-h-56 gap-1 overflow-auto">
              {targets.map((target) => (
                <label
                  key={target.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
                >
                  {/* Native checkbox: react-hook-form registers an
                      uncontrolled input by ref. */}
                  <input
                    type="checkbox"
                    value={target.id}
                    className="size-4 shrink-0 accent-primary"
                    {...registerTargetIds}
                  />
                  <span>{target.name}</span>
                </label>
              ))}
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
          </div>
          {error && <FieldError role="alert">{error}</FieldError>}
        </div>
      )}
    </>
  );
}
