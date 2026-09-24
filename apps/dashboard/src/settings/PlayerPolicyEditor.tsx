import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../api/client";
import type { SettingDefinition } from "../api/types";
import type { TFunction } from "i18next";
import { useAuth } from "../auth/AuthProvider";
import { SettingControl } from "./SettingControl";
import { descriptionFor, enumLabel, titleFor } from "./settingDisplay";
import { normalizeSettingValues } from "./settingValues";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Field, FieldLabel } from "../components/ui/field";
import { Switch } from "../components/ui/switch";

type PolicyGroupTitleKey =
  | "policies.groups.playback.title"
  | "policies.groups.storage.title"
  | "policies.groups.sync.title"
  | "policies.groups.websites.title"
  | "policies.groups.reliability.title"
  | "policies.groups.power.title"
  | "policies.groups.accessibility.title"
  | "policies.groups.updates.title";
type PolicyGroupDescriptionKey =
  | "policies.groups.playback.description"
  | "policies.groups.storage.description"
  | "policies.groups.sync.description"
  | "policies.groups.websites.description"
  | "policies.groups.reliability.description"
  | "policies.groups.power.description"
  | "policies.groups.accessibility.description"
  | "policies.groups.updates.description";

// Group headings hold translation keys, never rendered text. The titleKey
// doubles as the stable identifier for expansion state.
const policyGroups: {
  titleKey: PolicyGroupTitleKey;
  descriptionKey: PolicyGroupDescriptionKey;
  prefixes: readonly string[];
}[] = [
  {
    titleKey: "policies.groups.playback.title",
    descriptionKey: "policies.groups.playback.description",
    prefixes: ["player.playback."],
  },
  {
    titleKey: "policies.groups.storage.title",
    descriptionKey: "policies.groups.storage.description",
    prefixes: ["player.cache.", "player.download."],
  },
  {
    titleKey: "policies.groups.sync.title",
    descriptionKey: "policies.groups.sync.description",
    prefixes: ["player.sync.", "player.identify."],
  },
  {
    titleKey: "policies.groups.websites.title",
    descriptionKey: "policies.groups.websites.description",
    prefixes: ["player.website."],
  },
  {
    titleKey: "policies.groups.reliability.title",
    descriptionKey: "policies.groups.reliability.description",
    prefixes: ["reliability.", "managed_kiosk.", "linux_kiosk."],
  },
  {
    titleKey: "policies.groups.power.title",
    descriptionKey: "policies.groups.power.description",
    prefixes: ["power."],
  },
  {
    titleKey: "policies.groups.accessibility.title",
    descriptionKey: "policies.groups.accessibility.description",
    prefixes: ["accessibility."],
  },
  {
    titleKey: "policies.groups.updates.title",
    descriptionKey: "policies.groups.updates.description",
    prefixes: ["player.update."],
  },
];

export function PlayerPolicyEditor({
  target,
  id,
  onDirtyChange,
}: {
  target: "group" | "screen";
  id: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const manageable = ["owner", "administrator"].includes(
    auth.status?.user?.role ?? "",
  );
  const settings = useQuery({
    queryKey: ["settings", "policy-definitions"],
    queryFn: api.settings,
  });
  const policy = useQuery({
    queryKey: [target, id, "policy"],
    queryFn: () =>
      target === "group" ? api.groupPolicy(id) : api.screenPolicy(id),
  });
  const effective = useQuery({
    queryKey: ["screens", id, "effective-policy"],
    queryFn: () => api.effectivePolicy(id),
    enabled: target === "screen",
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [priority, setPriority] = useState(0);
  const [search, setSearch] = useState("");
  const [overriddenOnly, setOverriddenOnly] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initializedRevision = useRef<number | null>(null);

  useEffect(() => {
    if (!policy.data || initializedRevision.current === policy.data.revision)
      return;
    setValues(policy.data.values);
    setPriority(policy.data.priority ?? 0);
    setExpanded(
      new Set(
        policyGroups
          .filter((group) =>
            Object.keys(policy.data.values).some((key) =>
              group.prefixes.some((prefix) => key.startsWith(prefix)),
            ),
          )
          .map((group) => group.titleKey),
      ),
    );
    initializedRevision.current = policy.data.revision;
  }, [policy.data]);

  const baselineValues = policy.data?.values ?? {};
  const dirty =
    !samePolicyValues(values, baselineValues) ||
    (target === "group" && priority !== (policy.data?.priority ?? 0));

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () => {
      const normalizedValues = normalizeSettingValues(values, definitions);
      return target === "group"
        ? api.putGroupPolicy(
            id,
            policy.data?.revision ?? 0,
            priority,
            normalizedValues,
            auth.status?.csrfToken ?? "",
          )
        : api.putScreenPolicy(
            id,
            policy.data?.revision ?? 0,
            normalizedValues,
            auth.status?.csrfToken ?? "",
          );
    },
    onSuccess: async () => {
      initializedRevision.current = null;
      await policy.refetch();
      await effective.refetch();
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      target === "group"
        ? api.deleteGroupPolicy(id, auth.status?.csrfToken ?? "")
        : api.deleteScreenPolicy(id, auth.status?.csrfToken ?? ""),
    onSuccess: async () => {
      setValues({});
      initializedRevision.current = null;
      await policy.refetch();
      await effective.refetch();
    },
  });
  const definitions = (settings.data?.definitions ?? []).filter(
    (definition) => definition.scope === "policy",
  );
  const normalizedSearch = search.trim().toLowerCase();
  const grouped = useMemo(
    () =>
      policyGroups.map((group) => ({
        ...group,
        definitions: definitions.filter(
          (definition) =>
            group.prefixes.some((prefix) =>
              definition.key.startsWith(prefix),
            ) &&
            (!normalizedSearch ||
              definition.title.toLowerCase().includes(normalizedSearch) ||
              descriptionFor(definition)
                .toLowerCase()
                .includes(normalizedSearch)),
        ),
      })),
    [definitions, normalizedSearch],
  );
  const overrideCount = Object.keys(values).length;

  const cancelChanges = () => {
    setValues(baselineValues);
    setPriority(policy.data?.priority ?? 0);
  };

  return (
    <section className="space-y-4" aria-labelledby="player-policy-title">
      <header className="space-y-1">
        <h2 id="player-policy-title" className="text-lg font-medium">
          {target === "screen"
            ? t("policies.title.screen")
            : t("policies.title.group")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {target === "group"
            ? t("policies.description.group")
            : t("policies.description.screen")}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-64">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            placeholder={t("policies.searchPlaceholder")}
            aria-label={t("policies.searchLabel")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>
        <Field orientation="horizontal" className="items-center">
          <Switch
            id="player-settings-overridden-only"
            checked={overriddenOnly}
            onCheckedChange={setOverriddenOnly}
            aria-label={t("policies.overriddenOnly")}
          />
          <FieldLabel
            htmlFor="player-settings-overridden-only"
            className="font-normal"
          >
            {t("policies.overriddenOnly")}
          </FieldLabel>
        </Field>
        <Badge variant="secondary">
          {t("policies.overrides", { count: overrideCount })}
        </Badge>
        {manageable && (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!overrideCount || reset.isPending}
              onClick={() => setConfirmReset(true)}
            >
              {t("policies.resetAll")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("common:actions.saveChanges")}
            </Button>
          </>
        )}
      </div>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("policies.resetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("policies.resetDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("policies.keepOverrides")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {reset.isPending
                ? t("policies.resetting")
                : t("policies.resetAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {save.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("policies.saveErrorTitle")}</AlertTitle>
          <AlertDescription>
            {t("policies.saveErrorDescription")}
          </AlertDescription>
        </Alert>
      )}
      {save.isSuccess && !dirty && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("policies.saved")}
        </p>
      )}

      <div className="grid gap-3">
        {grouped.map((group) => {
          const definitionsToShow = overriddenOnly
            ? group.definitions.filter((definition) =>
                Object.hasOwn(values, definition.key),
              )
            : group.definitions;
          const sectionOverrideCount = group.definitions.filter((definition) =>
            Object.hasOwn(values, definition.key),
          ).length;
          const open =
            expanded.has(group.titleKey) ||
            Boolean(normalizedSearch && group.definitions.length);
          const hiddenByFilter =
            overriddenOnly && sectionOverrideCount === 0 && !normalizedSearch;
          if (hiddenByFilter) return null;
          return (
            <section
              className="rounded-xl border border-border"
              key={group.titleKey}
            >
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.titleKey)) next.delete(group.titleKey);
                    else next.add(group.titleKey);
                    return next;
                  })
                }
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {t(group.titleKey)}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {t(group.descriptionKey)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                  {t("policies.overrides", { count: sectionOverrideCount })}
                  <ChevronDown
                    size={18}
                    aria-hidden="true"
                    className={open ? "rotate-180" : undefined}
                  />
                </span>
              </button>
              {open && (
                <div className="grid gap-1 border-t border-border px-4 py-3">
                  {definitionsToShow.length ? (
                    definitionsToShow.map((definition) => (
                      <PolicyRow
                        key={definition.key}
                        definition={definition}
                        overridden={Object.hasOwn(values, definition.key)}
                        value={values[definition.key]}
                        inherited={
                          target === "screen"
                            ? effective.data?.values[definition.key]
                            : undefined
                        }
                        organizationValue={
                          settings.data?.values[definition.key] ??
                          definition.default
                        }
                        manageable={manageable}
                        overrideSource={
                          target === "group"
                            ? t("policies.groupOverride")
                            : t("policies.screenOverride")
                        }
                        onToggle={(enabled) => {
                          const next = { ...values };
                          if (enabled)
                            next[definition.key] =
                              (target === "screen"
                                ? effective.data?.values[definition.key]?.value
                                : undefined) ??
                              settings.data?.values[definition.key] ??
                              definition.default;
                          else delete next[definition.key];
                          setValues(next);
                        }}
                        onChange={(value) =>
                          setValues({ ...values, [definition.key]: value })
                        }
                      />
                    ))
                  ) : (
                    <p className="py-2 text-sm text-muted-foreground">
                      {normalizedSearch
                        ? t("policies.emptySearch")
                        : t("policies.emptySection")}
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {effective.data && (
        <Collapsible>
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("policies.advancedDetails")}
            <ChevronDown size={16} aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("policies.effectiveRevision", {
                revision: effective.data.configRevision,
              })}{" "}
              <code>{effective.data.hash.slice(0, 12)}</code>
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}

      {manageable && dirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <strong className="text-sm font-medium">
            {t("policies.unsaved")}
          </strong>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={cancelChanges}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("common:actions.saveChanges")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PolicyRow({
  definition,
  overridden,
  value,
  inherited,
  organizationValue,
  manageable,
  overrideSource,
  onToggle,
  onChange,
}: {
  definition: SettingDefinition;
  overridden: boolean;
  value: unknown;
  inherited?: { value: unknown; source: string };
  organizationValue: unknown;
  manageable: boolean;
  overrideSource: string;
  onToggle: (enabled: boolean) => void;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const title = titleFor(definition);
  const inheritedValue = inherited?.value ?? organizationValue;
  const source = inherited?.source ?? t("policies.organizationDefault");
  const effectiveValue = overridden ? value : inheritedValue;
  return (
    <div
      className={`grid gap-2 rounded-lg px-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start ${
        overridden ? "bg-muted/50" : ""
      }`}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">
          {descriptionFor(definition)}
        </p>
        <Collapsible>
          <CollapsibleTrigger className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("policies.advancedDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <code className="text-xs">{definition.key}</code>
          </CollapsibleContent>
        </Collapsible>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            {formatSettingValue(definition, effectiveValue, t)}
          </span>
          <Badge variant="secondary">
            {overridden ? overrideSource : source}
          </Badge>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Field orientation="horizontal" className="items-center">
          <Switch
            size="sm"
            id={"player-setting-override-" + definition.key}
            aria-label={t("policies.overrideSetting", { title })}
            checked={overridden}
            disabled={!manageable}
            onCheckedChange={(next) => onToggle(next)}
          />
          <FieldLabel
            htmlFor={"player-setting-override-" + definition.key}
            className="font-normal"
          >
            {overridden ? t("policies.overrideOn") : t("policies.overrideOff")}
          </FieldLabel>
        </Field>
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onToggle(false)}
          >
            {t("policies.revert")}
          </Button>
        )}
      </div>
      {overridden && (
        <div className="sm:col-span-2">
          <SettingControl
            definition={definition}
            value={value ?? definition.default}
            disabled={!manageable}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

const weekdayKeys = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

function formatSettingValue(
  definition: SettingDefinition,
  value: unknown,
  t: TFunction<["settings", "common"]>,
) {
  if (definition.key === "player.playback.default_volume")
    return `${Math.round(Number(value) * 100)}%`;
  if (definition.type === "int64" && definition.key.includes("bytes"))
    return formatBytes(Number(value));
  if (definition.type === "weekday_list") {
    return Array.isArray(value)
      ? value
          .map((day) => {
            const dayKey = weekdayKeys[Number(day) - 1];
            return dayKey ? t(`controls.weekdays.${dayKey}`) : undefined;
          })
          .filter(Boolean)
          .join(", ") || t("policies.valueNone")
      : t("policies.valueNone");
  }
  if (definition.type === "package_list")
    return Array.isArray(value)
      ? t("policies.allowedCount", { count: value.length })
      : t("policies.valueNoneAllowed");
  if (definition.type === "bool")
    return value ? t("controls.bool.on") : t("controls.bool.off");
  if (definition.type === "enum") return enumLabel(String(value));
  if (definition.key.endsWith("_seconds"))
    return formatDurationSeconds(Number(value), t);
  if (definition.key.endsWith("_minutes"))
    return t("policies.duration.minutes", { count: Number(value) });
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return t("policies.valueNotSet");
}

function formatDurationSeconds(
  value: number,
  t: TFunction<["settings", "common"]>,
) {
  if (value >= 3600 && value % 3600 === 0)
    return t("policies.duration.hours", { count: value / 3600 });
  if (value >= 60 && value % 60 === 0)
    return t("policies.duration.minutes", { count: value / 60 });
  return t("policies.duration.seconds", { count: value });
}

function formatBytes(bytes: number) {
  const units = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
  ] as const;
  const [size, unit] = units.find(([size]) => bytes >= size) ?? units[2];
  return `${Number((bytes / size).toFixed(2))} ${unit}`;
}

function samePolicyValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every(
      (key) => JSON.stringify(left[key]) === JSON.stringify(right[key]),
    )
  );
}
