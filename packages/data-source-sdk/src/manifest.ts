/**
 * `tilecast.datasource.json`: the declarative Data Source module manifest.
 * This Zod schema is the source of
 * `schema/tilecast-datasource.schema.json`. The shape reuses the proven
 * `contentdefs.DataSourceDefinition` concepts (identity, configuration
 * schema, defaults, output schema, refresh behavior, attribution, setup,
 * generic adapter id, bounded fetch, deprecation) with one addition: an
 * explicit `apiVersion`, separate from the definition/config version, that
 * versions the manifest format itself.
 *
 * The manifest never carries executable fields: no scripts, no Go
 * function names, no SQL, no expressions, no transforms, no process
 * execution, no sockets. Source/provenance is injected by discovery; the
 * file cannot declare its own source, so it can never lie about whether
 * it is core- or plugin-owned.
 */
import { z } from "zod";
import { DATA_TYPE_NAMES } from "./datatypes.ts";
import { ADAPTER_IDS } from "./fetch.ts";

export const MANIFEST_FILE = "tilecast.datasource.json";

export const dataSourceDirPattern = /^[a-z][a-z0-9-]{0,47}$/;
export const dataSourceIdPattern = /^[a-z][a-z0-9_-]{0,79}$/;
export const configKeyPattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Mirrors `supportedControls` in contentdefs: the exact Studio control set. */
const SUPPORTED_CONTROLS = [
  "text",
  "multiline_text",
  "number",
  "integer",
  "boolean",
  "select",
  "color",
  "date",
  "datetime",
  "timezone",
  "currency_code",
  "url",
  "data_source",
  "data_source_field",
  "media_asset",
  "repeating_group",
] as const;

const MAX_MANIFEST_VERSION = 9007199254740991;

/** Mirrors the output kinds `contentdefs` validation accepts. */
const OUTPUT_KINDS = [
  "scalar",
  "records",
  "time_series",
  "list",
  "object",
] as const;

const selectOptionSchema = z
  .object({ value: z.string(), label: z.string() })
  .strict();

type ConfigField = z.infer<typeof configFieldSchemaBase> & {
  itemFields?: ConfigField[];
};

const configFieldSchemaBase = z
  .object({
    key: z.string().regex(configKeyPattern),
    label: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
    control: z.enum(SUPPORTED_CONTROLS),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    options: z.array(selectOptionSchema).optional(),
    maximumItems: z.number().int().optional(),
    acceptedDataSourceKinds: z.array(z.string()).optional(),
    requiredFields: z.record(z.string(), z.string()).optional(),
    dataSourceFieldTypes: z.array(z.string()).optional(),
    mediaTypes: z.array(z.string()).optional(),
    ui: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const configFieldSchema: z.ZodType<ConfigField> = configFieldSchemaBase.extend({
  itemFields: z.array(z.lazy(() => configFieldSchema)).optional(),
});

const outputFieldSchema = z
  .object({
    key: z.string().regex(configKeyPattern),
    label: z.string().min(1).max(80),
    type: z.enum(DATA_TYPE_NAMES as [string, ...string[]]),
    currency: z.string().optional(),
    currencyConfigKey: z.string().regex(configKeyPattern).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const outputSchemaSchema = z
  .object({
    kind: z.enum(OUTPUT_KINDS),
    fields: z.array(outputFieldSchema),
  })
  .strict();

/**
 * Bounded fetch input for adapters that reach a release-pinned endpoint.
 * The shape mirrors Go's `FetchSpec`; `fetchSpecProblems` in fetch.ts
 * enforces the same safety rules the Server applies.
 */
const fetchSchema = z
  .object({
    urlTemplate: z.string().min(1).max(500),
    format: z.enum(["json", "csv"]),
    accept: z.string().max(120).optional(),
    recordsPath: z.string().max(200).optional(),
    mapping: z.record(z.string(), z.string()),
    maximumRecords: z.number().int().min(0).max(500).optional(),
    refreshSeconds: z.number().int().min(0).optional(),
  })
  .strict();

/** Mirrors Go's `Setup`: flat Studio presentation copy, nothing executable. */
const setupSchema = z
  .object({
    eyebrow: z.string().max(80).optional(),
    tip: z.string().max(500).optional(),
    steps: z.array(z.string().min(1).max(280)).max(12).optional(),
    emptyState: z.string().max(280).optional(),
  })
  .strict();

export const dataSourceManifestSchema = z
  .object({
    $schema: z.string().optional(),
    apiVersion: z.literal(1),
    id: z.string().regex(dataSourceIdPattern),
    version: z.number().int().min(1).max(MAX_MANIFEST_VERSION),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    category: z.string().min(1).max(40),
    icon: z.string().min(1).max(40),
    configurationSchema: z.object({ fields: z.array(configFieldSchema) }),
    defaultConfiguration: z.record(z.string(), z.unknown()),
    outputSchema: outputSchemaSchema,
    adapterId: z.enum(ADAPTER_IDS),
    fetch: fetchSchema.optional(),
    refreshBehavior: z.enum(["manual", "interval"]).optional(),
    // Compatibility metadata the release already attaches to definitions
    // (every current manual_*/http_records definition requires manifest
    // v13); a migrated module keeps its flag so behavior never changes.
    requiresManifestV13: z.boolean().optional(),
    setup: setupSchema.optional(),
    attribution: z.string().max(280).optional(),
    deprecation: z
      .object({
        // Legacy definitions write `"deprecation": {}` for "not
        // deprecated"; an omitted flag means the same.
        deprecated: z.boolean().optional(),
        replacement: z.string().max(80).optional(),
        message: z.string().max(280).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DataSourceManifestInput = z.input<typeof dataSourceManifestSchema>;
export type DataSourceManifest = z.output<typeof dataSourceManifestSchema>;
export type FetchDeclaration = NonNullable<DataSourceManifest["fetch"]>;

export function dataSourceManifestJSONSchema(): Record<string, unknown> {
  return z.toJSONSchema(dataSourceManifestSchema, { unrepresentable: "any" });
}

/** Every adapter id a manifest may name. */
export function adapterIds(): readonly string[] {
  return ADAPTER_IDS;
}
