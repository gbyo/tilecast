/**
 * The Studio model of host-owned Plugin Manifest API 3 instances and
 * settings: the API documents, the form state, and the pure conversions
 * between them. No React here, so the rules are easy to test.
 */
import {
  normalizeConfigValues,
  type ConfigField,
} from "@tilecast/config-schema";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import type { TargetScope } from "../../plugins/shared";

export type HostedKind = PluginManifestV3["instances"][number];

export type HostedPluginProps = {
  pluginId: string;
  manifest: PluginManifestV3;
  /** The instance kind this page is for, by its path. Defaults to the first. */
  kindPath?: string;
};

export function kindRoute(manifest: PluginManifestV3, kind: HostedKind) {
  return `${manifest.studio!.route}/${kind.path}`;
}

export type SecretState = "set" | "not_set" | "needs_value";

export interface HostedSchedule {
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  days?: number[];
  startTime?: string;
  endTime?: string;
}

/** One instance as the API returns it: host members beside the kind's fields. */
export interface HostedDocument {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  revision: number;
  priority?: number;
  targetScope?: TargetScope;
  targetIds?: string[];
  schedule?: HostedSchedule;
  secrets?: Record<string, SecretState>;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

const HOST_MEMBERS = new Set([
  "id",
  "kind",
  "plugin",
  "name",
  "enabled",
  "priority",
  "targetScope",
  "targetIds",
  "schedule",
  "revision",
  "secrets",
  "createdAt",
  "updatedAt",
  "createdBy",
]);

/** The editor's state for one instance. */
export interface HostedFormState {
  name: string;
  enabled: boolean;
  priority: number;
  targetScope: TargetScope;
  targetIds: string[];
  schedule: HostedSchedule;
  config: Record<string, unknown>;
  /** New secret values typed in this session; never loaded from the Server. */
  secrets: Record<string, string>;
  clearSecrets: string[];
}

/** The configuration the schema describes, with its defaults applied. */
export function configDefaults(
  fields: readonly ConfigField[],
  timezone: string,
): Record<string, unknown> {
  const result = normalizeConfigValues(
    fields.map((field) => ({ ...field, required: false })),
    {},
  );
  const values = result.ok ? { ...result.values } : {};
  // A required timezone starts at the organization's own zone.
  for (const field of fields)
    if (
      field.control === "timezone" &&
      field.required &&
      values[field.key] === undefined
    )
      values[field.key] = timezone;
  return values;
}

export function scheduleDefaults(
  kind: HostedKind,
  timezone: string,
  now = new Date(),
): HostedSchedule {
  if (kind.schedule === "weekly")
    return {
      timezone,
      days: [1, 2, 3, 4, 5],
      startTime: "08:00",
      endTime: "17:00",
    };
  if (kind.schedule === "window") {
    const later = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    return { startsAt: now.toISOString(), endsAt: later.toISOString() };
  }
  return {};
}

export function newFormState(
  kind: HostedKind,
  timezone: string,
): HostedFormState {
  return {
    name: "",
    enabled: true,
    priority: kind.priority?.default ?? 0,
    targetScope: "all",
    targetIds: [],
    schedule: scheduleDefaults(kind, timezone),
    config: configDefaults(kind.fields ?? [], timezone),
    secrets: {},
    clearSecrets: [],
  };
}

export function formStateOf(
  kind: HostedKind,
  document: HostedDocument,
  timezone: string,
): HostedFormState {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document))
    if (!HOST_MEMBERS.has(key) && value !== null) config[key] = value;
  return {
    name: document.name,
    enabled: document.enabled,
    priority: document.priority ?? kind.priority?.default ?? 0,
    targetScope: document.targetScope ?? "all",
    targetIds: document.targetIds ?? [],
    schedule: document.schedule ?? scheduleDefaults(kind, timezone),
    config,
    secrets: {},
    clearSecrets: [],
  };
}

/**
 * The request body for a create or update. A field the person cleared is
 * sent as null so the Server drops the stored value; the host replaces the
 * whole document on update.
 */
export function requestBody(
  kind: HostedKind,
  form: HostedFormState,
  expectedRevision?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    enabled: form.enabled,
  };
  for (const field of kind.fields ?? []) {
    if (field.control === "secret") continue;
    const value = form.config[field.key];
    body[field.key] =
      value === undefined || value === ""
        ? field.required
          ? value
          : null
        : value;
  }
  if (kind.priority) body["priority"] = form.priority;
  if (kind.targeting === "screens") {
    body["targetScope"] = form.targetScope;
    body["targetIds"] = form.targetScope === "all" ? [] : form.targetIds;
  }
  if (kind.schedule !== "none") body["schedule"] = form.schedule;
  const secrets = Object.fromEntries(
    Object.entries(form.secrets).filter(([, value]) => value !== ""),
  );
  if (Object.keys(secrets).length > 0) body["secrets"] = secrets;
  const clear = form.clearSecrets.filter((key) => !(key in secrets));
  if (clear.length > 0) body["clearSecrets"] = clear;
  if (expectedRevision !== undefined)
    body["expectedRevision"] = expectedRevision;
  return body;
}

export interface FormProblem {
  /** A field key, a host member name, or "schedule.<member>". */
  path: string;
  message: string;
}

/**
 * Early feedback before a save: the shared schema rules, the host members,
 * and the required secrets. The Server judges the request again.
 */
export function formProblems(
  kind: HostedKind,
  form: HostedFormState,
  secretStates: Record<string, SecretState> | undefined,
  messages: {
    name: string;
    targets: string;
    secretRequired: (label: string) => string;
  },
): FormProblem[] {
  const problems: FormProblem[] = [];
  if (form.name.trim() === "")
    problems.push({ path: "name", message: messages.name });
  if (
    kind.targeting === "screens" &&
    form.targetScope !== "all" &&
    form.targetIds.length === 0
  )
    problems.push({ path: "targets", message: messages.targets });
  const fields = kind.fields ?? [];
  const result = normalizeConfigValues(
    fields.filter((field) => field.control !== "secret"),
    Object.fromEntries(
      Object.entries(form.config).filter(
        ([, value]) => value !== undefined && value !== "",
      ),
    ),
  );
  if (!result.ok) problems.push({ path: result.path, message: result.problem });
  const clearedSecrets = new Set(form.clearSecrets);
  for (const field of fields) {
    if (field.control !== "secret" || !field.required) continue;
    const typed = (form.secrets[field.key] ?? "") !== "";
    const stored = secretStates?.[field.key] === "set";
    const cleared = clearedSecrets.has(field.key);
    if (!typed && (!stored || cleared))
      problems.push({
        path: field.key,
        message: messages.secretRequired(field.label),
      });
  }
  return problems;
}

/** Synthetic fields that let the shared field renderer draw a host schedule. */
export function scheduleFields(
  kind: HostedKind,
  label: (key: keyof HostedSchedule) => string,
): ConfigField[] {
  if (kind.schedule === "window")
    return [
      {
        key: "startsAt",
        label: label("startsAt"),
        control: "datetime",
        required: true,
      },
      {
        key: "endsAt",
        label: label("endsAt"),
        control: "datetime",
        required: true,
      },
    ];
  if (kind.schedule === "weekly")
    return [
      {
        key: "timezone",
        label: label("timezone"),
        control: "timezone",
        required: true,
      },
      {
        key: "days",
        label: label("days"),
        control: "weekdays",
        required: true,
      },
      {
        key: "startTime",
        label: label("startTime"),
        control: "time",
        required: true,
      },
      {
        key: "endTime",
        label: label("endTime"),
        control: "time",
        required: true,
      },
    ];
  return [];
}

/** A short line describing an instance in a list: its first text field. */
export function summaryOf(kind: HostedKind, document: HostedDocument): string {
  for (const field of kind.fields) {
    const value = document[field.key];
    if (typeof value === "string" && value !== "" && field.control === "text")
      return value;
  }
  return "";
}
