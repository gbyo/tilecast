import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../api/client";
import type { SettingDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { SettingControl } from "./SettingControl";
import { descriptionFor, enumLabel } from "./settingDisplay";
import { normalizeSettingValues } from "./settingValues";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog as RheaAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
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
import { Switch as RheaSwitch } from "../components/ui/switch";

const policyGroups = [
  {
    title: "Playback",
    description: "Default presentation and volume behavior.",
    prefixes: ["player.playback."],
  },
  {
    title: "Storage and downloads",
    description: "Local cache limits and content delivery behavior.",
    prefixes: ["player.cache.", "player.download."],
  },
  {
    title: "Synchronization",
    description: "Server reconciliation, status, and diagnostics.",
    prefixes: ["player.sync.", "player.identify."],
  },
  {
    title: "Websites",
    description: "Timeout, cookies, and local website data behavior.",
    prefixes: ["player.website."],
  },
  {
    title: "Reliability and kiosk",
    description:
      "Shared recovery plus platform-specific Android and Linux kiosk behavior.",
    prefixes: ["reliability.", "managed_kiosk.", "linux_kiosk."],
  },
  {
    title: "Active hours and power",
    description: "Operating hours, sleep requests, and black-screen fallback.",
    prefixes: ["power."],
  },
  {
    title: "Accessibility control",
    description: "Automatic return behavior and safe maintenance exclusions.",
    prefixes: ["accessibility."],
  },
  {
    title: "Player updates",
    description: "Screen-specific update download and installation behavior.",
    prefixes: ["player.update."],
  },
] as const;

export function PlayerPolicyEditor({
  target,
  id,
  onDirtyChange,
}: {
  target: "group" | "screen";
  id: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
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
          .map((group) => group.title),
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
          {target === "screen" ? "Screen behavior" : "Player policy"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {target === "group"
            ? "Override organization defaults for this Display Group."
            : "Override inherited playback and device behavior for this screen only."}
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
            placeholder="Search settings"
            aria-label="Search player settings"
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <RheaSwitch
            checked={overriddenOnly}
            onCheckedChange={setOverriddenOnly}
            aria-label="Overridden only"
          />
          Overridden only
        </label>
        <Badge variant="secondary">
          {overrideCount} {overrideCount === 1 ? "override" : "overrides"}
        </Badge>
        {manageable && (
          <>
            <RheaButton
              type="button"
              variant="destructive"
              size="sm"
              disabled={!overrideCount || reset.isPending}
              onClick={() => setConfirmReset(true)}
            >
              Reset all overrides
            </RheaButton>
            <RheaButton
              type="button"
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </RheaButton>
          </>
        )}
      </div>
      <RheaAlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset every player-setting override?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This clears every player-setting override for this target. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep overrides</AlertDialogCancel>
            <AlertDialogAction
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {reset.isPending ? "Resetting…" : "Reset all overrides"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </RheaAlertDialog>

      {save.isError && (
        <Alert variant="destructive">
          <AlertTitle>Settings could not be saved</AlertTitle>
          <AlertDescription>
            Reload the current policy if another administrator changed it.
          </AlertDescription>
        </Alert>
      )}
      {save.isSuccess && !dirty && (
        <p className="text-sm text-muted-foreground" role="status">
          Player settings saved.
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
            expanded.has(group.title) ||
            Boolean(normalizedSearch && group.definitions.length);
          const hiddenByFilter =
            overriddenOnly && sectionOverrideCount === 0 && !normalizedSearch;
          if (hiddenByFilter) return null;
          return (
            <section
              className="rounded-xl border border-border"
              key={group.title}
            >
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.title)) next.delete(group.title);
                    else next.add(group.title);
                    return next;
                  })
                }
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {group.title}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {group.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                  {sectionOverrideCount}{" "}
                  {sectionOverrideCount === 1 ? "override" : "overrides"}
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
                            ? "Group override"
                            : "Screen override"
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
                        ? "No matching settings in this section."
                        : "No screen-level settings are available in this section."}
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
            Advanced details
            <ChevronDown size={16} aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 text-sm text-muted-foreground">
              Effective configuration revision {effective.data.configRevision} ·{" "}
              <code>{effective.data.hash.slice(0, 12)}</code>
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}

      {manageable && dirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <strong className="text-sm font-medium">
            Unsaved player-setting changes
          </strong>
          <div className="flex flex-wrap items-center gap-2">
            <RheaButton
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={cancelChanges}
            >
              Cancel
            </RheaButton>
            <RheaButton
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </RheaButton>
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
  const inheritedValue = inherited?.value ?? organizationValue;
  const source = inherited?.source ?? "Organization default";
  const effectiveValue = overridden ? value : inheritedValue;
  return (
    <div
      className={`grid gap-2 rounded-lg px-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start ${
        overridden ? "bg-muted/50" : ""
      }`}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{definition.title}</p>
        <p className="text-sm text-muted-foreground">
          {descriptionFor(definition)}
        </p>
        <Collapsible>
          <CollapsibleTrigger className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Advanced details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <code className="text-xs">{definition.key}</code>
          </CollapsibleContent>
        </Collapsible>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            {formatSettingValue(definition, effectiveValue)}
          </span>
          <Badge variant="secondary">
            {overridden ? overrideSource : source}
          </Badge>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <RheaSwitch
            size="sm"
            aria-label={`Override ${definition.title}`}
            checked={overridden}
            disabled={!manageable}
            onCheckedChange={(next) => onToggle(next)}
          />
          {overridden ? "Override on" : "Override"}
        </label>
        {overridden && (
          <RheaButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onToggle(false)}
          >
            Revert
          </RheaButton>
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

function formatSettingValue(definition: SettingDefinition, value: unknown) {
  if (definition.key === "player.playback.default_volume")
    return `${Math.round(Number(value) * 100)}%`;
  if (definition.type === "int64" && definition.key.includes("bytes"))
    return formatBytes(Number(value));
  if (definition.type === "weekday_list") {
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return Array.isArray(value)
      ? value
          .map((day) => labels[Number(day) - 1])
          .filter(Boolean)
          .join(", ") || "None"
      : "None";
  }
  if (definition.type === "package_list")
    return Array.isArray(value) ? `${value.length} allowed` : "None allowed";
  if (definition.type === "bool") return value ? "On" : "Off";
  if (definition.type === "enum") return enumLabel(String(value));
  if (definition.key.endsWith("_seconds")) return formatSeconds(Number(value));
  if (definition.key.endsWith("_minutes"))
    return `${Number(value)} ${Number(value) === 1 ? "minute" : "minutes"}`;
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return "Not set";
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

function formatSeconds(seconds: number) {
  if (seconds >= 3600 && seconds % 3600 === 0)
    return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds >= 60 && seconds % 60 === 0)
    return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
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
