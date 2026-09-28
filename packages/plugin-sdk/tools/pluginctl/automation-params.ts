/**
 * OpenAPI-derived automation metadata.
 *
 * `automation.yaml` stays small: it only says WHICH operation is exposed
 * and how it is presented (CLI path, MCP action, risk class). Everything
 * about HOW the HTTP operation is shaped (path/query parameters, their
 * types, the request-body schema) already lives in the plugin's OpenAPI
 * fragment, so `pluginctl` derives it here at generation time into the
 * resolved `automation.gen.json` artifact. The generic CLI and MCP read
 * only the generated artifact, never YAML or OpenAPI themselves.
 *
 * Shapes that cannot be represented generically (non-JSON bodies,
 * object/array query parameters, exotic schema combinators) are
 * generation problems, never silent omissions: the plugin is told
 * exactly what to change instead of shipping broken CLI/MCP surface.
 *
 * Traversal works on plain JSON values (Document.toJSON()), not YAML
 * nodes, so there is no node/value confusion.
 */
import YAML from "yaml";
import type { Problem } from "./repo.ts";

/** One scalar parameter the generic CLI/MCP can express. */
export interface ParamMeta {
  name: string;
  required: boolean;
  type: string;
  format?: string;
  enum?: (string | number | boolean)[];
  description?: string;
}

/** A JSON request body, simplified to plain JSON Schema. */
export interface BodyMeta {
  required: boolean;
  schema: Record<string, unknown>;
}

/** Everything generation derives for one automated operation. */
export interface OperationMetadata {
  pathParams: ParamMeta[];
  queryParams: ParamMeta[];
  requestBody?: BodyMeta;
}

/** Lifecycle words owned by `tilecast plugin` itself. No automated CLI
 * root may claim them: `tilecast plugin list` must always list plugins. */
export const PLUGIN_LIFECYCLE_WORDS = ["list", "get", "install", "remove"];

const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

const PRIMITIVE_TYPES = new Set(["string", "integer", "number", "boolean"]);
const MAX_SCHEMA_DEPTH = 6;

type JsonMap = Record<string, unknown>;

function isMap(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toDoc(text: string): { json: unknown; ok: boolean } {
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length > 0) return { json: null, ok: false };
    return { json: doc.toJSON(), ok: true };
  } catch {
    return { json: null, ok: false };
  }
}

/** Split a $ref into document part and components pointer, if shaped so. */
function splitRef(ref: string): { doc: string; pointer: string } | null {
  const hash = ref.indexOf("#");
  if (hash < 0) return null;
  return { doc: ref.slice(0, hash), pointer: ref.slice(hash + 1) };
}

/** Match a /components/<section>/<Name> pointer. */
function componentName(pointer: string, section: string): string | null {
  const match = pointer.match(/^\/components\/([^/]+)\/([^/]+)$/);
  if (!match || match[1] !== section) return null;
  return match[2]!;
}

function lookupComponent(
  root: unknown,
  section: string,
  name: string,
): JsonMap | null {
  if (!isMap(root)) return null;
  const components = root["components"];
  if (!isMap(components)) return null;
  const group = components[section];
  if (!isMap(group)) return null;
  const entry = group[name];
  return isMap(entry) ? entry : null;
}

/**
 * Resolve a $ref against the fragment first, then core. Only component
 * references resolve; anything else is null (a clear problem upstream).
 */
function resolveRef(
  ref: string,
  fragment: unknown,
  core: unknown,
): JsonMap | null {
  const split = splitRef(ref);
  if (!split) return null;
  const { doc, pointer } = split;
  if (doc === "") {
    const node = lookupPointer(fragment, pointer);
    return isMap(node) ? node : null;
  }
  if (core !== null && /(^|\/)core\.yaml$/.test(doc)) {
    const node = lookupPointer(core, pointer);
    return isMap(node) ? node : null;
  }
  return null;
}

function lookupPointer(root: unknown, pointer: string): unknown {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = root;
  for (const part of parts) {
    if (!isMap(current)) return undefined;
    current = current[part];
  }
  return current;
}

interface OperationEntry {
  operationId: string;
  at: string;
  operation: JsonMap;
}

function collectFragmentEntries(fragment: unknown): OperationEntry[] {
  const found: OperationEntry[] = [];
  if (!isMap(fragment)) return found;
  const paths = fragment["paths"];
  if (!isMap(paths)) return found;
  for (const [path, item] of Object.entries(paths)) {
    if (!isMap(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method) || !isMap(operation)) continue;
      const operationId = operation["operationId"];
      if (!isString(operationId)) continue;
      found.push({
        operationId,
        at: `${method.toUpperCase()} ${path} (${operationId})`,
        operation,
      });
    }
  }
  return found;
}

/** Simplify one schema value to plain JSON Schema. */
function simplifySchema(
  node: unknown,
  fragment: unknown,
  core: unknown,
  seen: string[],
  depth: number,
): { schema?: Record<string, unknown>; error?: string } {
  if (depth > MAX_SCHEMA_DEPTH)
    return { error: "schema nesting exceeds the automation depth limit" };
  if (!isMap(node)) return { error: "schema entry is not a mapping" };
  const ref = node["$ref"];
  if (ref !== undefined) {
    if (!isString(ref)) return { error: "schema $ref is not a string" };
    const pointer = splitRef(ref)?.pointer ?? "";
    const name =
      componentName(pointer, "schemas") ??
      componentName(pointer, "requestBodies");
    if (name === null)
      return {
        error: `schema reference ${JSON.stringify(ref)} is not a local or core component`,
      };
    if (seen.includes(ref))
      return { error: `schema reference ${JSON.stringify(ref)} is recursive` };
    const target = resolveRef(ref, fragment, core);
    if (!target)
      return {
        error: `schema reference ${JSON.stringify(ref)} does not resolve`,
      };
    return simplifySchema(target, fragment, core, [...seen, ref], depth + 1);
  }
  for (const combinator of ["allOf", "oneOf", "anyOf", "not"]) {
    if (node[combinator] !== undefined)
      return {
        error: `schema combinator ${JSON.stringify(combinator)} cannot be automated generically`,
      };
  }
  const type = node["type"];
  if (type !== undefined && !isString(type))
    return { error: "schema type is not a string" };
  const rawEnum = node["enum"];
  if (
    type === undefined &&
    node["properties"] === undefined &&
    !(Array.isArray(rawEnum) && rawEnum.length > 0)
  )
    return { error: "schema has no type and no properties" };
  // An enum without a type constrains to its values; infer a scalar type
  // when the values agree so generic clients stay typed.
  let effectiveType = type ?? "object";
  if (type === undefined && Array.isArray(rawEnum) && rawEnum.length > 0) {
    const kinds = new Set(rawEnum.map((item) => typeof item));
    effectiveType =
      kinds.size === 1 && kinds.has("string")
        ? "string"
        : kinds.size === 1 && kinds.has("number")
          ? "number"
          : kinds.size === 1 && kinds.has("boolean")
            ? "boolean"
            : "";
  }
  if (
    effectiveType !== "object" &&
    effectiveType !== "array" &&
    !PRIMITIVE_TYPES.has(effectiveType)
  )
    return {
      error: `schema type ${JSON.stringify(effectiveType)} cannot be automated generically`,
    };
  const out: Record<string, unknown> = {};
  if (effectiveType !== "") out.type = effectiveType;
  for (const key of ["format", "description", "default", "pattern"]) {
    const value = node[key];
    if (isString(value)) out[key] = value;
  }
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ]) {
    const value = node[key];
    if (typeof value === "number") out[key] = value;
  }
  if (node["uniqueItems"] === true) out.uniqueItems = true;
  const enumNode = node["enum"];
  if (enumNode !== undefined) {
    if (!Array.isArray(enumNode)) return { error: `"enum" is not a sequence` };
    const values: (string | number | boolean)[] = [];
    for (const item of enumNode) {
      if (
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      )
        return {
          error: `"enum" holds only string, number, or boolean values for automation`,
        };
      values.push(item);
    }
    out.enum = values;
  }
  if (effectiveType === "array") {
    const items = node["items"];
    if (items === undefined) return { error: `array schema has no "items"` };
    const simplified = simplifySchema(items, fragment, core, seen, depth + 1);
    if (simplified.error !== undefined) return simplified;
    out.items = simplified.schema;
  }
  if (effectiveType === "object") {
    const required = node["required"];
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every(isString))
        return { error: `"required" is not a string sequence` };
      out.required = required;
    }
    const properties = node["properties"];
    if (properties !== undefined) {
      if (!isMap(properties)) return { error: `"properties" is not a mapping` };
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(properties)) {
        const simplified = simplifySchema(
          prop,
          fragment,
          core,
          seen,
          depth + 1,
        );
        if (simplified.error !== undefined)
          return {
            error: `property ${JSON.stringify(name)}: ${simplified.error}`,
          };
        props[name] = simplified.schema;
      }
      out.properties = props;
    }
    const additional = node["additionalProperties"];
    if (additional !== undefined) {
      if (typeof additional === "boolean")
        out.additionalProperties = additional;
      else {
        const simplified = simplifySchema(
          additional,
          fragment,
          core,
          seen,
          depth + 1,
        );
        if (simplified.error !== undefined) return simplified;
        out.additionalProperties = simplified.schema;
      }
    }
  }
  return { schema: out };
}

/** Read one scalar parameter's metadata. */
function readParam(
  entry: JsonMap,
  location: string,
  at: string,
): { param?: ParamMeta; error?: string } {
  const name = entry["name"];
  if (!isString(name)) return { error: `${at}: parameter has no name` };
  const schemaNode = entry["schema"];
  if (!isMap(schemaNode))
    return { error: `${at}: parameter ${JSON.stringify(name)} has no schema` };
  if (schemaNode["$ref"] !== undefined)
    return {
      error: `${at}: parameter ${JSON.stringify(name)} hides its schema behind a reference; inline the scalar schema`,
    };
  const type = schemaNode["type"];
  if (!isString(type) || !PRIMITIVE_TYPES.has(type))
    return {
      error: `${at}: parameter ${JSON.stringify(name)} has non-scalar type ${JSON.stringify(type)}`,
    };
  const param: ParamMeta = {
    name,
    required: entry["required"] === true,
    type,
  };
  const format = schemaNode["format"];
  if (isString(format)) param.format = format;
  const enumNode = schemaNode["enum"];
  if (enumNode !== undefined) {
    if (!Array.isArray(enumNode))
      return {
        error: `${at}: parameter ${JSON.stringify(name)} "enum" is not a sequence`,
      };
    const values: (string | number | boolean)[] = [];
    for (const item of enumNode) {
      if (
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      )
        return {
          error: `${at}: parameter ${JSON.stringify(name)} "enum" holds only scalar values`,
        };
      values.push(item);
    }
    param.enum = values;
  }
  const description = entry["description"];
  if (isString(description)) param.description = description;
  else if (isString(schemaNode["description"]))
    param.description = schemaNode["description"];
  if (location === "path" && !param.required)
    return {
      error: `${at}: path parameter ${JSON.stringify(name)} must be required`,
    };
  return { param };
}

/**
 * Derive automation metadata for every operation in a fragment.
 * Returns per-operation metadata plus problems for shapes the generic
 * CLI/MCP cannot express. Header and cookie parameters (CSRF and
 * friends) are transport concerns and are skipped, never automated.
 */
export function extractOperationMetadata(
  plugin: string,
  file: string,
  fragmentText: string,
  coreText: string | null,
): { metadata: Map<string, OperationMetadata>; problems: Problem[] } {
  const problems: Problem[] = [];
  const metadata = new Map<string, OperationMetadata>();
  const add = (message: string) => problems.push({ plugin, file, message });

  const parsed = toDoc(fragmentText);
  if (!parsed.ok) return { metadata, problems };
  const fragment = parsed.json;
  let core: unknown = null;
  if (coreText !== null) {
    const coreParsed = toDoc(coreText);
    if (coreParsed.ok) core = coreParsed.json;
  }

  for (const { operationId, at, operation } of collectFragmentEntries(
    fragment,
  )) {
    const meta: OperationMetadata = { pathParams: [], queryParams: [] };

    const parameters = operation["parameters"];
    if (parameters !== undefined) {
      if (!Array.isArray(parameters)) {
        add(`${at}: "parameters" is not a sequence`);
        continue;
      }
      let failed = false;
      for (const item of parameters) {
        let entry: unknown = item;
        if (isMap(item) && isString(item["$ref"])) {
          const target = resolveRef(item["$ref"], fragment, core);
          if (!target) {
            add(
              `${at}: parameter reference ${JSON.stringify(item["$ref"])} does not resolve`,
            );
            failed = true;
            break;
          }
          entry = target;
        }
        if (!isMap(entry)) {
          add(`${at}: parameter entry is not a mapping`);
          failed = true;
          break;
        }
        const location = entry["in"];
        if (location === "header" || location === "cookie") continue;
        if (location !== "path" && location !== "query") {
          add(
            `${at}: parameter location ${JSON.stringify(location)} cannot be automated generically`,
          );
          failed = true;
          break;
        }
        const read = readParam(entry, location, at);
        if (read.error !== undefined) {
          add(read.error);
          failed = true;
          break;
        }
        if (location === "path") meta.pathParams.push(read.param!);
        else meta.queryParams.push(read.param!);
      }
      if (failed) continue;
    }

    const bodyNode = operation["requestBody"];
    if (bodyNode !== undefined) {
      let bodyMap: unknown = bodyNode;
      if (isMap(bodyNode) && isString(bodyNode["$ref"])) {
        const target = resolveRef(bodyNode["$ref"], fragment, core);
        if (!target) {
          add(
            `${at}: requestBody reference ${JSON.stringify(bodyNode["$ref"])} does not resolve`,
          );
          continue;
        }
        bodyMap = target;
      }
      if (!isMap(bodyMap)) {
        add(`${at}: requestBody is not a mapping`);
        continue;
      }
      const content = bodyMap["content"];
      if (!isMap(content)) {
        add(`${at}: requestBody has no content`);
        continue;
      }
      const jsonContent = content["application/json"];
      if (!isMap(jsonContent)) {
        add(
          `${at}: only application/json request bodies can be automated generically`,
        );
        continue;
      }
      if (jsonContent["schema"] === undefined) {
        add(`${at}: request body has no schema`);
        continue;
      }
      const simplified = simplifySchema(
        jsonContent["schema"],
        fragment,
        core,
        [],
        0,
      );
      if (simplified.error !== undefined) {
        add(`${at}: request body schema: ${simplified.error}`);
        continue;
      }
      if (simplified.schema?.type !== "object") {
        add(
          `${at}: request body schema must be an object for generic automation`,
        );
        continue;
      }
      meta.requestBody = {
        required: bodyMap["required"] === true,
        schema: simplified.schema,
      };
    }

    metadata.set(operationId, meta);
  }
  return { metadata, problems };
}
