/**
 * Early value checks for Studio. The Server normalizer in
 * `go/configschema/values.go` is authoritative and also checks that named
 * resources (Data Sources, media assets, library fonts) exist; this mirror
 * checks only what a browser can know, with the same messages, so an editor
 * can show a problem before it saves.
 */
import { isTimeOfDay, weekdaysOf, type ConfigField } from "./fields.ts";

export type NormalizeResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; problem: string; path: string };

class ValueProblem extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.path = path;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const colorPattern = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const rfc3339Pattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text)
  );
}

function validTimeZone(text: string): boolean {
  if (text === "" || text === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a configuration document the way the Server does, without the
 * resource lookups. A secret value is refused: a secret travels only
 * through the secret store. A connection value is a connection record ID;
 * the Server checks that the record belongs to the plugin.
 */
export function normalizeConfigValues(
  fields: readonly ConfigField[],
  input: Readonly<Record<string, unknown>>,
): NormalizeResult {
  try {
    return { ok: true, values: normalizeObject(fields, input, "") };
  } catch (error) {
    if (error instanceof ValueProblem) {
      return { ok: false, problem: error.message, path: error.path };
    }
    throw error;
  }
}

function normalizeObject(
  fields: readonly ConfigField[],
  input: Readonly<Record<string, unknown>>,
  prefix: string,
): Record<string, unknown> {
  const known = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new ValueProblem(
        `configuration contains unknown field "${prefix}${key}"`,
        prefix + key,
      );
    }
  }
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const path = prefix + field.key;
    let value = input[field.key];
    let present = Object.hasOwn(input, field.key);
    if (field.control === "secret") {
      if (present && value !== null && value !== undefined) {
        throw new ValueProblem(
          `${field.label} is a secret and is written through the secret store`,
          path,
        );
      }
      continue;
    }
    if ((!present || value === undefined) && field.default !== undefined) {
      value = field.default;
      present = true;
    }
    if (
      !present ||
      value === null ||
      value === undefined ||
      (field.required && value === "")
    ) {
      if (field.required)
        throw new ValueProblem(`${field.label} is required`, path);
      continue;
    }
    output[field.key] = normalizeField(field, value, path);
  }
  return output;
}

function normalizeField(
  field: ConfigField,
  value: unknown,
  path: string,
): unknown {
  const fail = (message: string): never => {
    throw new ValueProblem(message, path);
  };
  switch (field.control) {
    case "text":
    case "multiline_text":
    case "color":
    case "date":
    case "datetime":
    case "local_datetime":
    case "time":
    case "timezone":
    case "currency_code":
    case "url":
    case "data_source":
    case "data_source_field":
    case "media_asset":
    case "font":
    case "connection": {
      if (typeof value !== "string") return fail(`${field.label} must be text`);
      let text = value.trim();
      const length = byteLength(text);
      if (
        ((field.minLength ?? 0) > 0 && length < (field.minLength ?? 0)) ||
        ((field.maxLength ?? 0) > 0 && length > (field.maxLength ?? 0))
      ) {
        return fail(`${field.label} length is outside the allowed range`);
      }
      switch (field.control) {
        case "currency_code":
          if (text !== "") {
            text = text.toUpperCase();
            if (!/^[A-Z]{3}$/.test(text) || text === "XXX") {
              return fail(
                `${field.label} must be a recognized ISO 4217 currency code`,
              );
            }
          }
          break;
        case "color":
          if (text === "" && !field.required) break;
          if (!colorPattern.test(text)) {
            return fail(`${field.label} must be a hexadecimal color`);
          }
          text = text.toLowerCase();
          break;
        case "date":
          if (text !== "" && !validDate(text))
            return fail(`${field.label} must be a date`);
          break;
        case "datetime":
          if (text !== "") {
            const parsed = new Date(text);
            if (!rfc3339Pattern.test(text) || Number.isNaN(parsed.getTime())) {
              return fail(`${field.label} must be an RFC 3339 datetime`);
            }
            text = parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
          }
          break;
        case "local_datetime":
          if (
            text !== "" &&
            !localDateTimePattern.test(text) &&
            !rfc3339Pattern.test(text)
          ) {
            return fail(`${field.label} must be a local date and time`);
          }
          break;
        case "time":
          if (text === "" && !field.required) break;
          if (!isTimeOfDay(text))
            return fail(`${field.label} must be a time written HH:MM`);
          break;
        case "timezone":
          if (!validTimeZone(text))
            return fail(`${field.label} must be an IANA timezone`);
          break;
        case "url": {
          let parsed: URL | null = null;
          try {
            parsed = new URL(text);
          } catch {
            parsed = null;
          }
          if (
            !parsed ||
            (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            parsed.host === ""
          ) {
            return fail(`${field.label} must be an HTTP or HTTPS URL`);
          }
          break;
        }
        case "data_source":
          if (!uuidPattern.test(text))
            return fail(`${field.label} must identify a Data Source`);
          text = text.toLowerCase();
          break;
        case "media_asset":
          if (text === "" && !field.required) break;
          if (!uuidPattern.test(text))
            return fail(`${field.label} must identify a media asset`);
          text = text.toLowerCase();
          break;
        case "font":
          if (text === "" && !field.required) break;
          if (!uuidPattern.test(text) || /^0{8}-(0{4}-){3}0{12}$/.test(text)) {
            return fail(`${field.label} must identify a library font`);
          }
          text = text.toLowerCase();
          break;
        case "connection":
          if (text === "" && !field.required) break;
          if (!uuidPattern.test(text) || /^0{8}-(0{4}-){3}0{12}$/.test(text)) {
            return fail(`${field.label} must identify a connection`);
          }
          text = text.toLowerCase();
          break;
      }
      return text;
    }
    case "number":
    case "integer": {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.control === "integer" && !Number.isInteger(value))
      ) {
        return fail(`${field.label} must be a ${field.control}`);
      }
      if (
        (field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum)
      ) {
        return fail(`${field.label} is outside the allowed range`);
      }
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean")
        return fail(`${field.label} must be true or false`);
      return value;
    case "select":
      if (typeof value !== "string")
        return fail(`${field.label} must be selected`);
      if (!(field.options ?? []).some((option) => option.value === value)) {
        return fail(`${field.label} has an invalid selection`);
      }
      return value;
    case "weekdays": {
      const days = weekdaysOf(value);
      if (!days) {
        return fail(
          `${field.label} must contain unique days from 0 (Sunday) through 6`,
        );
      }
      if (field.required && days.length === 0)
        return fail(`${field.label} is required`);
      return days;
    }
    case "string_list": {
      if (!Array.isArray(value) || value.length > (field.maximumItems ?? 0)) {
        return fail(`${field.label} exceeds its bounded item limit`);
      }
      const out: string[] = [];
      for (const item of value) {
        if (typeof item !== "string")
          return fail(`${field.label} must contain only text`);
        const text = item.trim();
        if (text === "") continue;
        const length = byteLength(text);
        if (
          ((field.minLength ?? 0) > 0 && length < (field.minLength ?? 0)) ||
          ((field.maxLength ?? 0) > 0 && length > (field.maxLength ?? 0))
        ) {
          return fail(
            `${field.label} contains an entry outside the allowed length`,
          );
        }
        out.push(text);
      }
      return out;
    }
    case "repeating_group": {
      if (!Array.isArray(value) || value.length > (field.maximumItems ?? 0)) {
        return fail(`${field.label} exceeds its bounded item limit`);
      }
      return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return fail(`${field.label} item ${index + 1} is invalid`);
        }
        return normalizeObject(
          field.itemFields ?? [],
          item as Record<string, unknown>,
          `${path}[${index}].`,
        );
      });
    }
    default:
      return fail("unsupported release-defined form control");
  }
}
