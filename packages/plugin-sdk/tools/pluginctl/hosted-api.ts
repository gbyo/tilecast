/**
 * Generated API for Plugin Manifest API 3 plugins. Core owns the routes of
 * host-owned settings and instances, so pluginctl derives their OpenAPI
 * operations and their Automation Contract mapping from the manifest
 * instead of a hand-written fragment. A plugin's own fragment and
 * automation.yaml still describe the routes it registers itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { ConfigField } from "@tilecast/config-schema";
import { AUTOMATION_FILENAME } from "../../src/automation.ts";
import type { InstanceKind, PluginManifest } from "../../src/manifest.ts";
import type { DiscoveredPlugin } from "./repo.ts";

/** A core component reference written from plugins/<dir>/api/. */
const core = (path: string) => ({
  $ref: `../../../docs/openapi/core.yaml#/components/${path}`,
});

const timePattern = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

/** The JSON Schema of one configuration field's value. */
function fieldSchema(field: ConfigField): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (field.description) out["description"] = field.description;
  else out["description"] = field.label;
  switch (field.control) {
    case "integer":
    case "number":
      out["type"] = field.control;
      if (field.minimum !== undefined) out["minimum"] = field.minimum;
      if (field.maximum !== undefined) out["maximum"] = field.maximum;
      break;
    case "boolean":
      out["type"] = "boolean";
      break;
    case "select":
      out["enum"] = (field.options ?? []).map((option) => option.value);
      break;
    case "weekdays":
      out["type"] = "array";
      out["uniqueItems"] = true;
      out["maxItems"] = 7;
      out["items"] = { type: "integer", minimum: 0, maximum: 6 };
      break;
    case "string_list":
      out["type"] = "array";
      out["maxItems"] = field.maximumItems;
      out["items"] = { type: "string" };
      break;
    case "repeating_group":
      out["type"] = "array";
      out["maxItems"] = field.maximumItems;
      out["items"] = objectSchema(field.itemFields ?? []);
      break;
    case "time":
      out["type"] = "string";
      out["pattern"] = timePattern;
      break;
    case "datetime":
      out["type"] = "string";
      out["format"] = "date-time";
      break;
    case "date":
      out["type"] = "string";
      out["format"] = "date";
      break;
    case "font":
    case "media_asset":
      // Omit the member, or send null, to choose nothing.
      out["type"] = "string";
      out["format"] = "uuid";
      break;
    default:
      out["type"] = "string";
      if (field.maxLength) out["maxLength"] = field.maxLength;
  }
  if (field.default !== undefined && field.default !== null)
    out["default"] = field.default;
  return out;
}

function objectSchema(fields: readonly ConfigField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.control === "secret" || field.control === "connection") continue;
    properties[field.key] = fieldSchema(field);
  }
  return { type: "object", additionalProperties: false, properties };
}

function secretsSchema(fields: readonly ConfigField[]) {
  const keys = fields
    .filter((field) => field.control === "secret")
    .map((field) => field.key);
  if (keys.length === 0) return {};
  return {
    secrets: {
      type: "object",
      additionalProperties: false,
      description:
        "Secret values to store. They are encrypted and never returned; reads report only whether each is set.",
      properties: Object.fromEntries(
        keys.map((key) => [key, { type: "string", minLength: 1 }]),
      ),
    },
    clearSecrets: {
      type: "array",
      uniqueItems: true,
      items: { enum: keys },
      description: "Secret keys to clear.",
    },
  };
}

const secretStates = {
  type: "object",
  description:
    "For each secret field: set, not_set, or needs_value (stored but unreadable on this server after a restore without its key).",
  additionalProperties: { enum: ["set", "not_set", "needs_value"] },
};

function scheduleSchema(kind: InstanceKind) {
  if (kind.schedule === "window")
    return {
      type: "object",
      additionalProperties: false,
      required: ["startsAt", "endsAt"],
      properties: {
        startsAt: { type: "string", format: "date-time" },
        endsAt: { type: "string", format: "date-time" },
      },
    };
  if (kind.schedule === "weekly")
    return {
      type: "object",
      additionalProperties: false,
      required: ["timezone", "days", "startTime", "endTime"],
      properties: {
        timezone: { type: "string" },
        days: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", minimum: 0, maximum: 6 },
        },
        startTime: { type: "string", pattern: timePattern },
        endTime: { type: "string", pattern: timePattern },
      },
    };
  return null;
}

/** The instance request schema: host members beside the kind's fields. */
function inputSchema(kind: InstanceKind, update: boolean) {
  const fields = (kind.fields ?? []) as ConfigField[];
  const config = objectSchema(fields);
  const properties: Record<string, unknown> = {
    name: { type: "string", minLength: 1, maxLength: 180 },
    enabled: {
      type: "boolean",
      description: "Defaults to true on create and keeps its value on update.",
    },
    ...(config["properties"] as Record<string, unknown>),
    ...secretsSchema(fields),
  };
  const required = ["name"];
  if (kind.priority)
    properties["priority"] = {
      type: "integer",
      minimum: kind.priority.minimum,
      maximum: kind.priority.maximum,
      default: kind.priority.default,
    };
  if (kind.targeting === "screens") {
    properties["targetScope"] = {
      enum: ["all", "screens", "sync_groups", "locations"],
    };
    properties["targetIds"] = {
      type: "array",
      uniqueItems: true,
      maxItems: 250,
      items: { type: "string", format: "uuid" },
    };
    required.push("targetScope", "targetIds");
  }
  const schedule = scheduleSchema(kind);
  if (schedule) {
    properties["schedule"] = schedule;
    required.push("schedule");
  }
  if (update) {
    properties["expectedRevision"] = {
      type: "integer",
      minimum: 1,
      description:
        "The revision this change is based on, from the last read. A stale revision answers 409 and changes nothing; a missing one answers 428.",
    };
    required.push("expectedRevision");
  }
  for (const field of fields)
    if (
      field.required &&
      field.default === undefined &&
      field.control !== "secret"
    )
      required.push(field.key);
  return { type: "object", additionalProperties: false, required, properties };
}

function documentSchema(kind: InstanceKind, singular: string) {
  return {
    allOf: [
      { $ref: `#/components/schemas/${singular}Input` },
      {
        type: "object",
        required: ["id", "kind", "revision", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { const: kind.kind },
          revision: { type: "integer", minimum: 1 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          ...(((kind.fields ?? []) as ConfigField[]).some(
            (field) => field.control === "secret",
          )
            ? { secrets: secretStates }
            : {}),
        },
      },
    ],
  };
}

const data = (schema: unknown) => ({
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["data"],
        properties: { data: schema },
      },
    },
  },
});

/** The generated OpenAPI fragment, or null for a plugin without one. */
export function generatedFragment(
  manifest: PluginManifest,
): Record<string, unknown> | null {
  if (manifest.apiVersion !== 3) return null;
  const base = manifest.api?.basePaths[0];
  if (!base) return null;
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  const name = manifest.name;
  const settings = manifest.settings;
  for (const [scope, fields] of [
    ["organization", settings?.organization ?? []],
    ["screen", settings?.screen ?? []],
  ] as const) {
    if (fields.length === 0) continue;
    const schemaName = `${pascal(manifest.id)}${scope === "organization" ? "Organization" : "Screen"}Settings`;
    const path =
      scope === "organization"
        ? `/api/v1${base}/settings/organization`
        : `/api/v1${base}/settings/screens/{screenId}`;
    const parameters =
      scope === "screen"
        ? [
            {
              name: "screenId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : [];
    schemas[schemaName] = objectSchema(fields as ConfigField[]);
    paths[path] = {
      get: {
        operationId: `get${schemaName}`,
        description: `Read the ${name} ${scope} settings. Secrets report only whether each is set.`,
        parameters,
        responses: {
          "200": {
            description: "Settings",
            ...data({
              type: "object",
              properties: {
                values: { $ref: `#/components/schemas/${schemaName}` },
                secrets: secretStates,
                revision: { type: "integer", minimum: 0 },
              },
            }),
          },
          "404": { description: "Not found" },
        },
      },
      put: {
        operationId: `update${schemaName}`,
        description: `Replace the ${name} ${scope} settings. Requires plugins.manage.`,
        parameters: [...parameters, core("parameters/CSRFToken")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["values", "expectedRevision"],
                properties: {
                  values: { $ref: `#/components/schemas/${schemaName}` },
                  ...secretsSchema(fields as ConfigField[]),
                  expectedRevision: {
                    type: "integer",
                    minimum: 0,
                    description: "0 for settings never saved.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Settings replaced" },
          "400": { description: "A value is invalid" },
          "409": { description: "Stale revision; nothing changed" },
          "428": { description: "expectedRevision is missing" },
        },
      },
    };
  }
  for (const kind of manifest.instances) {
    const { singular, plural } = kind.operations;
    schemas[`${singular}Input`] = inputSchema(kind, false);
    schemas[`${singular}Update`] = inputSchema(kind, true);
    schemas[singular] = documentSchema(kind, singular);
    const collection = `/api/v1${base}/${kind.path}`;
    const noun = kind.noun;
    paths[collection] = {
      get: {
        operationId: `list${plural}`,
        description: `List ${noun.plural}, strongest priority first.`,
        responses: {
          "200": {
            description: `${noun.plural}`,
            ...data({
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: { $ref: `#/components/schemas/${singular}` },
                },
                total: { type: "integer" },
              },
            }),
          },
        },
      },
      post: {
        operationId: `create${singular}`,
        description: `Create a ${noun.singular}. Requires plugins.manage and screen access to its targets.`,
        parameters: [core("parameters/CSRFToken")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${singular}Input` },
            },
          },
        },
        responses: {
          "201": {
            description: `${noun.singular} created`,
            ...data({ $ref: `#/components/schemas/${singular}` }),
          },
          "400": { description: "Configuration or targets are invalid" },
          "403": { description: "Capability or screen access missing" },
          "409": { description: "The plugin is not installed" },
        },
      },
    };
    paths[`${collection}/{id}`] = {
      get: {
        operationId: `get${singular}`,
        description: `Get one ${noun.singular} with its current revision, to send back as expectedRevision when updating it.`,
        parameters: [core("parameters/ResourceID")],
        responses: {
          "200": {
            description: `${noun.singular}`,
            ...data({ $ref: `#/components/schemas/${singular}` }),
          },
          "404": { description: "Not found" },
        },
      },
      put: {
        operationId: `update${singular}`,
        description: `Replace a ${noun.singular} when expectedRevision is current. Requires plugins.manage and screen access to its current and new targets.`,
        parameters: [
          core("parameters/ResourceID"),
          core("parameters/CSRFToken"),
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${singular}Update` },
            },
          },
        },
        responses: {
          "200": {
            description: `${noun.singular} replaced`,
            ...data({ $ref: `#/components/schemas/${singular}` }),
          },
          "400": { description: "Configuration or targets are invalid" },
          "403": { description: "Capability or screen access missing" },
          "404": { description: "Not found" },
          "409": { description: "Stale revision; nothing changed" },
          "428": { description: "expectedRevision is missing" },
        },
      },
      delete: {
        operationId: `delete${singular}`,
        description: `Delete a ${noun.singular} and remove it from its screens.`,
        parameters: [
          core("parameters/ResourceID"),
          core("parameters/CSRFToken"),
        ],
        responses: {
          "204": { description: `${noun.singular} deleted` },
          "403": { description: "Capability or screen access missing" },
          "404": { description: "Not found" },
        },
      },
    };
  }
  if (Object.keys(paths).length === 0) return null;
  return {
    openapi: "3.1.0",
    info: { title: `${name} plugin API`, version: "1" },
    paths,
    components: { schemas },
  };
}

/** The generated automation operations of a plugin's instance kinds. */
export function generatedAutomation(
  manifest: PluginManifest,
): Record<string, unknown>[] {
  if (manifest.apiVersion !== 3) return [];
  const dir = manifest.id.replaceAll("_", "-");
  const out: Record<string, unknown>[] = [];
  for (const kind of manifest.instances) {
    const { singular, plural } = kind.operations;
    const noun = kind.noun;
    const listAction = `list_${kind.path.replaceAll("-", "_")}`;
    out.push(
      {
        operationId: `list${plural}`,
        risk: "read",
        description: `List the ${noun.plural}.`,
        cli: { path: [dir, kind.kind, "list"] },
        mcp: { action: listAction },
      },
      {
        operationId: `get${singular}`,
        risk: "read",
        description: `Show one ${noun.singular}.`,
        cli: { path: [dir, kind.kind, "get"] },
        mcp: { action: `get_${kind.kind}` },
      },
      {
        operationId: `create${singular}`,
        risk: "routine",
        description: `Create a ${noun.singular} from a JSON document.`,
        cli: { path: [dir, kind.kind, "create"] },
        mcp: { action: `create_${kind.kind}` },
        input: "document",
      },
      {
        operationId: `update${singular}`,
        risk: "routine",
        description: `Replace a ${noun.singular} from a JSON document that names the expectedRevision it read.`,
        cli: { path: [dir, kind.kind, "update"] },
        mcp: { action: `update_${kind.kind}` },
        input: "document",
      },
      {
        operationId: `delete${singular}`,
        risk: "sensitive",
        description: `Delete a ${noun.singular} from its target screens.`,
        cli: { path: [dir, kind.kind, "delete"] },
        mcp: { action: `delete_${kind.kind}` },
      },
    );
  }
  return out;
}

function pascal(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The plugin's effective OpenAPI fragment: its own fragment, if any, with
 * the generated operations merged in. Paths and schemas are relative to
 * plugins/<dir>/api/, like a hand-written fragment.
 */
export function effectiveFragment(
  plugin: DiscoveredPlugin,
): { text: string; file: string; dir: string } | null {
  const declared = plugin.manifest.api?.openapi;
  const ownText =
    declared && existsSync(join(plugin.path, declared))
      ? readFileSync(join(plugin.path, declared), "utf8")
      : null;
  const own = parseOwn(ownText);
  const generated = generatedFragment(plugin.manifest);
  if (ownText === null && !generated) return null;
  const file = declared
    ? join("plugins", plugin.dir, declared)
    : join("plugins", plugin.dir, "tilecast.plugin.json");
  const dir = join(plugin.path, "api");
  // Without generated operations, or when the plugin's own file does not
  // parse, its raw text goes on so the existing checks report it.
  if (!generated || (ownText !== null && !own)) {
    return { text: ownText ?? "", file, dir };
  }
  const merged: Record<string, unknown> = own ?? {
    openapi: "3.1.0",
    info: generated["info"],
  };
  merged["paths"] = {
    ...((merged["paths"] as object) ?? {}),
    ...(generated["paths"] as object),
  };
  const components = (merged["components"] as Record<string, unknown>) ?? {};
  components["schemas"] = {
    ...((components["schemas"] as object) ?? {}),
    ...((generated["components"] as Record<string, object>)["schemas"] ?? {}),
  };
  merged["components"] = components;
  return { text: YAML.stringify(merged, { lineWidth: 0 }), file, dir };
}

/**
 * The plugin's effective automation document text: its own automation.yaml,
 * if any, with the generated operations added.
 */
export function effectiveAutomation(
  plugin: DiscoveredPlugin,
): { text: string; file: string } | null {
  const ownPath = join(plugin.path, AUTOMATION_FILENAME);
  const ownText = existsSync(ownPath) ? readFileSync(ownPath, "utf8") : null;
  const own = parseOwn(ownText);
  const generated = generatedAutomation(plugin.manifest);
  if (ownText === null && generated.length === 0) return null;
  const file =
    ownText !== null
      ? join("plugins", plugin.dir, AUTOMATION_FILENAME)
      : join("plugins", plugin.dir, "tilecast.plugin.json");
  if (generated.length === 0 || (ownText !== null && !own))
    return { text: ownText ?? "", file };
  const document = own ?? { apiVersion: 1, operations: [], exclusions: [] };
  document["operations"] = [
    ...((document["operations"] as unknown[]) ?? []),
    ...generated,
  ];
  document["exclusions"] = document["exclusions"] ?? [];
  return { text: YAML.stringify(document, { lineWidth: 0 }), file };
}

/** A plugin's own YAML file as an object, or null when absent or unparsable. */
function parseOwn(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = YAML.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
