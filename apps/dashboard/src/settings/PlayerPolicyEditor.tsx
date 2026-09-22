import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../api/client";
import type { SettingDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { SettingControl } from "./SettingControl";
import { descriptionFor, enumLabel } from "./settingDisplay";
import { normalizeSettingValues } from "./settingValues";

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
  const { confirm } = useSpectrumDialogs();
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
    <section className="policy-editor" aria-labelledby="player-policy-title">
      <header className="policy-editor__heading">
        <div>
          <h2 id="player-policy-title">
            {target === "screen" ? "Screen behavior" : "Player policy"}
          </h2>
          <p>
            {target === "group"
              ? "Override organization defaults for this Display Group."
              : "Override inherited playback and device behavior for this screen only."}
          </p>
        </div>
      </header>

      <div className="policy-toolbar">
        <label className="policy-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="Search settings"
            aria-label="Search player settings"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={overriddenOnly}
          className="setting-switch policy-filter-switch"
          onClick={() => setOverriddenOnly((current) => !current)}
        >
          <span aria-hidden="true" />
          <strong>Overridden only</strong>
        </button>
        <span className="policy-override-count">
          <strong>{overrideCount}</strong>{" "}
          {overrideCount === 1 ? "override" : "overrides"}
        </span>
        {manageable && (
          <>
            <button
              type="button"
              className="button button--danger-quiet button--compact"
              disabled={!overrideCount || reset.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Reset every player-setting override?",
                    description:
                      "All overrides for this target will be removed. This cannot be undone.",
                    confirmLabel: "Reset overrides",
                    tone: "negative",
                  })
                )
                  reset.mutate();
              }}
            >
              Reset all overrides
            </button>
            <button
              type="button"
              className="button button--primary button--compact"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </>
        )}
      </div>

      {save.isError && (
        <div className="notice notice--error" role="alert">
          Settings could not be saved. Reload the current policy if another
          administrator changed it.
        </div>
      )}
      {save.isSuccess && !dirty && (
        <p className="policy-save-status" role="status">
          Player settings saved.
        </p>
      )}

      <div className="policy-sections">
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
            <section className="policy-section" key={group.title}>
              <button
                type="button"
                className="policy-section-toggle"
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
                <span>
                  <strong>{group.title}</strong>
                  <small>{group.description}</small>
                </span>
                <span className="policy-section-toggle__meta">
                  {sectionOverrideCount}{" "}
                  {sectionOverrideCount === 1 ? "override" : "overrides"}
                  <ChevronDown size={18} aria-hidden="true" />
                </span>
              </button>
              {open && (
                <div className="policy-section__rows">
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
                    <p className="policy-section__empty">
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
        <details className="policy-advanced">
          <summary>Advanced details</summary>
          Effective configuration revision {
            effective.data.configRevision
          } · <code>{effective.data.hash.slice(0, 12)}</code>
        </details>
      )}

      {manageable && dirty && (
        <div className="policy-action-bar">
          <strong>Unsaved player-setting changes</strong>
          <div>
            <button
              type="button"
              className="button button--secondary"
              disabled={save.isPending}
              onClick={cancelChanges}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
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
    <div className={`policy-row${overridden ? " policy-row--overridden" : ""}`}>
      <div className="policy-row__identity">
        <strong>{definition.title}</strong>
        <small>{descriptionFor(definition)}</small>
        <details className="policy-row__advanced">
          <summary>Advanced details</summary>
          <code>{definition.key}</code>
        </details>
      </div>
      <div className="policy-row__effective">
        <strong>{formatSettingValue(definition, effectiveValue)}</strong>
        <span className="source-badge">
          {overridden ? overrideSource : source}
        </span>
      </div>
      <div className="policy-row__override">
        <button
          type="button"
          role="switch"
          aria-label={`Override ${definition.title}`}
          aria-checked={overridden}
          className="setting-switch setting-switch--compact"
          disabled={!manageable}
          onClick={() => onToggle(!overridden)}
        >
          <span aria-hidden="true" />
          <strong>{overridden ? "Override on" : "Override"}</strong>
        </button>
        {overridden && (
          <button
            type="button"
            className="policy-revert"
            onClick={() => onToggle(false)}
          >
            Revert
          </button>
        )}
      </div>
      {overridden && (
        <div className="policy-row__control">
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
