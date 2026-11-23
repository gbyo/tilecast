/**
 * The Tilecast configuration schema: the field vocabulary Widget
 * definitions and Plugin Manifest API 3 plugins share.
 *
 * One vocabulary, two profiles. The `widget` profile is a Widget
 * definition's `configurationSchema`. The `plugin` profile is an API 3
 * plugin's settings or instance schema; it adds the plugin-only controls
 * `secret` and `connection` and the `personal` marker, which the `widget`
 * profile refuses.
 *
 * The Go validator in `go/configschema` is authoritative on the Server. This
 * module mirrors every shape rule so Studio, pluginctl, and widgetctl refuse
 * the same documents early; the fixtures in `testdata/` keep the two halves
 * in agreement.
 *
 * `packages/settings-schema` is the Player configuration schema. It is a
 * different contract.
 */
import { z } from "zod";

export type ConfigProfile = "widget" | "plugin";

/** Controls every profile accepts. */
export const SHARED_CONTROLS = [
  "text",
  "multiline_text",
  "number",
  "integer",
  "boolean",
  "select",
  "color",
  "date",
  "datetime",
  "local_datetime",
  "time",
  "timezone",
  "currency_code",
  "url",
  "data_source",
  "data_source_field",
  "media_asset",
  "repeating_group",
  "string_list",
  "font",
  "weekdays",
] as const;

/**
 * Plugin-only controls. A secret value is stored only through the secret
 * store and is never part of a configuration document. A connection value
 * is the ID of a host-owned connection record of the same plugin;
 * `connections` names the declarations the field accepts.
 */
export const PLUGIN_ONLY_CONTROLS = ["secret", "connection"] as const;

export type SharedControl = (typeof SHARED_CONTROLS)[number];
export type PluginOnlyControl = (typeof PLUGIN_ONLY_CONTROLS)[number];
export type ConfigControl = SharedControl | PluginOnlyControl;

/** The library font bound shared with the Player Runtime and Player state. */
export const MAX_FONT_FIELDS = 4;
/** The largest secret value, in bytes. */
export const MAX_SECRET_BYTES = 4096;
/** The most connection declarations one connection field accepts. */
export const MAX_FIELD_CONNECTIONS = 8;
const connectionIdPattern = /^[a-z][a-z0-9_]{0,39}$/;
export const MIN_PERSONAL_RETENTION_DAYS = 1;
export const MAX_PERSONAL_RETENTION_DAYS = 3650;

export function controlsFor(profile: ConfigProfile): readonly ConfigControl[] {
  return profile === "plugin"
    ? [...SHARED_CONTROLS, ...PLUGIN_ONLY_CONTROLS]
    : SHARED_CONTROLS;
}

export type ConfigAuthoringSection =
  | "data"
  | "content"
  | "appearance"
  | "behavior";

/** Show a control only when another configuration value matches. */
export interface ConfigVisibleWhen {
  /** The other configuration key to compare. */
  readonly key: string;
  /** Visible when the value equals this (or any of these). */
  readonly equals?: unknown;
  /** Visible when the value differs from this (and all of these). */
  readonly notEquals?: unknown;
}

/** Studio authoring hints. Unknown or malformed hints are ignored. */
export interface ConfigFieldUi {
  section?: ConfigAuthoringSection;
  order?: number;
  visibleWhen?: ConfigVisibleWhen | ConfigVisibleWhen[];
  hidden?: boolean;
  styleCard?: boolean;
  slider?: boolean;
  advanced?: boolean;
  semanticRole?: string;
  legacyKeys?: string[];
  typeFallback?: boolean;
  /**
   * An integer stored in seconds that a person enters in whole minutes.
   * The stored value and its bounds stay in seconds.
   */
  inputUnit?: "minutes";
}

/** The personal-data declaration of one plugin field. */
export interface ConfigPersonal {
  retentionDays: number;
}

export interface ConfigSelectOption {
  value: string;
  label: string;
  /** A Studio translation key for `label`. */
  labelKey?: string;
}

/** One configuration field. */
export interface ConfigField {
  key: string;
  label: string;
  /** A Studio translation key for `label`; the literal text is the fallback. */
  labelKey?: string;
  description?: string;
  /** A Studio translation key for `description`. */
  descriptionKey?: string;
  control: ConfigControl;
  required?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  options?: ConfigSelectOption[];
  acceptedDataSourceKinds?: string[];
  requiredFields?: Record<string, string>;
  dataSourceFieldTypes?: string[];
  /**
   * For a `data_source_field` control: the key of the `data_source` control
   * whose selected source supplies this field list.
   */
  dataSourceKey?: string;
  mediaTypes?: string[];
  maximumItems?: number;
  itemFields?: ConfigField[];
  ui?: ConfigFieldUi;
  /** Plugin profile only: the field holds personal data. */
  personal?: ConfigPersonal;
  /** Plugin profile, connection control: the declarations it accepts. */
  connections?: string[];
}

const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);

/** The JSON shape of a field for a profile. Semantic rules follow in problems(). */
export function configFieldSchema(
  profile: ConfigProfile,
): z.ZodType<ConfigField> {
  const field: z.ZodType<ConfigField> = z.lazy(() =>
    z.strictObject({
      key: z.string(),
      label: z.string(),
      labelKey: z.string().optional(),
      description: z.string().optional(),
      descriptionKey: z.string().optional(),
      control: z.enum(controlsFor(profile) as [ConfigControl, ...ConfigControl[]]),
      required: z.boolean().optional(),
      default: json.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.int().min(0).optional(),
      maxLength: z.int().min(0).optional(),
      options: z
        .array(
          z.strictObject({
            value: z.string(),
            label: z.string(),
            labelKey: z.string().optional(),
          }),
        )
        .optional(),
      acceptedDataSourceKinds: z.array(z.string()).optional(),
      requiredFields: z.record(z.string(), z.string()).optional(),
      dataSourceFieldTypes: z.array(z.string()).optional(),
      dataSourceKey: z.string().optional(),
      mediaTypes: z.array(z.string()).optional(),
      maximumItems: z.int().optional(),
      itemFields: z.array(field).optional(),
      ui: z.record(z.string(), json).optional(),
      personal: z
        .strictObject({
          retentionDays: z
            .int()
            .min(MIN_PERSONAL_RETENTION_DAYS)
            .max(MAX_PERSONAL_RETENTION_DAYS),
        })
        .optional(),
      connections: z.array(z.string()).optional(),
    }),
  ) as z.ZodType<ConfigField>;
  return field;
}

/** The JSON shape of a whole field list for a profile, with semantic rules. */
export function configFieldsSchema(profile: ConfigProfile) {
  return z
    .array(configFieldSchema(profile))
    .superRefine((fields, context) => {
      for (const message of configSchemaProblems(fields, profile)) {
        context.addIssue({ code: "custom", message });
      }
    });
}

/**
 * Maps a media_asset field key to the key manifest projection writes its
 * resolved variant under ("logoAssetId" gives "logoVariantId").
 */
export function derivedVariantKey(assetKey: string): string {
  return `${assetKey.endsWith("AssetId") ? assetKey.slice(0, -"AssetId".length) : assetKey}VariantId`;
}

const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && timePattern.test(value);
}

/** Unique whole days 0 (Sunday) through 6, or null. */
export function weekdaysOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 7) return null;
  const seen = new Set<number>();
  for (const item of value) {
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 0 ||
      item > 6 ||
      seen.has(item)
    )
      return null;
    seen.add(item);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Every shape rule the Go validator applies, for one profile. Returns the
 * problems; an empty list is a valid schema.
 */
export function configSchemaProblems(
  fields: readonly ConfigField[],
  profile: ConfigProfile,
): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(controlsFor(profile));
  const plugin = new Set<string>(PLUGIN_ONLY_CONTROLS);

  const level = (fields: readonly ConfigField[], depth: number) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (!field.key || seen.has(field.key)) {
        problems.push(
          "configuration schema contains a missing or duplicate field key",
        );
        continue;
      }
      seen.add(field.key);
      if (!allowed.has(field.control)) {
        problems.push(
          plugin.has(field.control)
            ? `configuration schema uses the plugin-only control "${field.control}"`
            : `configuration schema uses unsupported form control "${field.control}"`,
        );
      }
      if (field.personal !== undefined) {
        if (profile !== "plugin") {
          problems.push(
            `field "${field.key}" uses the plugin-only personal marker`,
          );
        } else {
          const days = field.personal.retentionDays;
          if (
            !Number.isInteger(days) ||
            days < MIN_PERSONAL_RETENTION_DAYS ||
            days > MAX_PERSONAL_RETENTION_DAYS
          ) {
            problems.push(
              `personal field "${field.key}" must declare a retention between ${MIN_PERSONAL_RETENTION_DAYS} and ${MAX_PERSONAL_RETENTION_DAYS} days`,
            );
          }
        }
      }
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      ) {
        problems.push(
          `field "${field.key}" has a minimum greater than its maximum`,
        );
      }
      if ((field.minLength ?? 0) < 0 || (field.maxLength ?? 0) < 0) {
        problems.push(`field "${field.key}" has a negative length bound`);
      }
      if (
        (field.maxLength ?? 0) > 0 &&
        (field.minLength ?? 0) > (field.maxLength ?? 0)
      ) {
        problems.push(
          `field "${field.key}" has a minimum length greater than its maximum length`,
        );
      }
      switch (field.control) {
        case "select":
          if (!field.options || field.options.length === 0) {
            problems.push(`select field "${field.key}" has no options`);
          } else if (field.default !== undefined && field.default !== null) {
            if (typeof field.default !== "string") {
              problems.push(`select field "${field.key}" default must be text`);
            } else if (
              !field.options.some((option) => option.value === field.default)
            ) {
              problems.push(
                `select field "${field.key}" default is not one of its options`,
              );
            }
          }
          break;
        case "time":
          if (
            field.default !== undefined &&
            field.default !== null &&
            !isTimeOfDay(field.default)
          ) {
            problems.push(`time field "${field.key}" default must be HH:MM`);
          }
          break;
        case "weekdays":
          if (
            field.default !== undefined &&
            field.default !== null &&
            weekdaysOf(field.default) === null
          ) {
            problems.push(
              `weekdays field "${field.key}" default must be unique days from 0 through 6`,
            );
          }
          break;
        case "secret":
        case "connection":
          if (depth > 0) {
            problems.push(
              `${field.control} field "${field.key}" must be at the top level`,
            );
          }
          if (field.default !== undefined && field.default !== null) {
            problems.push(
              `${field.control} field "${field.key}" cannot declare a default`,
            );
          }
          if (
            field.control === "secret" &&
            (field.maxLength ?? 0) > MAX_SECRET_BYTES
          ) {
            problems.push(
              `secret field "${field.key}" allows more than ${MAX_SECRET_BYTES} bytes`,
            );
          }
          break;
      }
      if (field.control === "connection") {
        const accepted = field.connections ?? [];
        if (accepted.length < 1 || accepted.length > MAX_FIELD_CONNECTIONS) {
          problems.push(
            `connection field "${field.key}" must accept 1 to ${MAX_FIELD_CONNECTIONS} connection declarations`,
          );
        }
        const seenConnections = new Set<string>();
        for (const id of accepted) {
          if (!connectionIdPattern.test(id) || seenConnections.has(id)) {
            problems.push(
              `connection field "${field.key}" names an invalid or repeated connection "${id}"`,
            );
          }
          seenConnections.add(id);
        }
      } else if ((field.connections ?? []).length > 0) {
        problems.push(
          `field "${field.key}" lists connections but is not a connection field`,
        );
      }
      if (
        field.required &&
        typeof field.default === "string" &&
        field.default.trim() === ""
      ) {
        problems.push(`required field "${field.key}" declares an empty default`);
      }
      if (
        field.control === "string_list" &&
        ((field.maximumItems ?? 0) < 1 || (field.maximumItems ?? 0) > 100)
      ) {
        problems.push(`string list "${field.key}" has invalid bounds`);
      }
      if (field.control === "repeating_group") {
        if ((field.maximumItems ?? 0) < 1 || (field.maximumItems ?? 0) > 100) {
          problems.push(`repeating group "${field.key}" has invalid bounds`);
        }
        if (!field.itemFields || field.itemFields.length === 0) {
          problems.push(`repeating group "${field.key}" declares no item fields`);
        } else {
          level(field.itemFields, depth + 1);
        }
      }
    }
    const derived = new Set<string>();
    for (const field of fields) {
      if (field.control !== "media_asset" || !field.key) continue;
      const key = derivedVariantKey(field.key);
      if (seen.has(key) || derived.has(key)) {
        problems.push(
          `media_asset field "${field.key}" derives configuration key "${key}" that conflicts with another field`,
        );
      }
      derived.add(key);
    }
  };
  level(fields, 0);

  let fonts = 0;
  const hasFont = (fields: readonly ConfigField[]): boolean =>
    fields.some(
      (field) =>
        field.control === "font" ||
        (field.control === "repeating_group" && hasFont(field.itemFields ?? [])),
    );
  for (const field of fields) {
    if (field.control === "font") {
      fonts++;
      if (
        field.default !== undefined &&
        field.default !== null &&
        field.default !== ""
      ) {
        problems.push(`font field "${field.key}" must default to empty`);
      }
    } else if (
      field.control === "repeating_group" &&
      hasFont(field.itemFields ?? [])
    ) {
      problems.push(`repeating group "${field.key}" may not contain a font field`);
    }
  }
  if (fonts > MAX_FONT_FIELDS) {
    problems.push(
      `configuration schema declares more than ${MAX_FONT_FIELDS} font fields`,
    );
  }

  const sources = new Set<string>();
  const collect = (fields: readonly ConfigField[]) => {
    for (const field of fields) {
      if (field.control === "data_source") sources.add(field.key);
      if (field.control === "repeating_group") collect(field.itemFields ?? []);
    }
  };
  collect(fields);
  const walk = (fields: readonly ConfigField[]) => {
    for (const field of fields) {
      if (
        field.control === "data_source_field" &&
        field.dataSourceKey &&
        !sources.has(field.dataSourceKey)
      ) {
        problems.push(
          `field "${field.key}" refers to unknown Data Source "${field.dataSourceKey}"`,
        );
      }
      if (field.control === "repeating_group") walk(field.itemFields ?? []);
    }
  };
  walk(fields);
  return problems;
}

/** Top-level secret field keys, in schema order. */
export function secretKeys(fields: readonly ConfigField[]): string[] {
  return fields
    .filter((field) => field.control === "secret")
    .map((field) => field.key);
}
