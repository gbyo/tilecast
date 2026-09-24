import type { FormField, FormSchema } from "../api/types";
import type { FormValues } from "./FormRenderer";
import { isPresentationControl } from "./formSchema";
import {
  localDateTimeToRfc3339,
  rfc3339ToLocalDateTime,
} from "../lib/dateTime";

export {
  localDateTimeToRfc3339,
  rfc3339ToLocalDateTime,
} from "../lib/dateTime";

// coerceScalar turns an unknown stored value into the string the renderer edits. Strings, numbers,
// and booleans stringify directly; anything else (objects/arrays for a scalar field) becomes empty.
export function coerceScalar(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

// recordValuesToForm converts a stored record value map (unknown JSON values) into the typed
// FormValues the renderer edits. Datetime fields are converted from RFC 3339 to the local input
// format; image fields keep their attachment asset id string.
export function recordValuesToForm(
  schema: FormSchema,
  values: Record<string, unknown> | undefined,
): FormValues {
  const result: FormValues = {};
  const source = values ?? {};
  for (const field of schema.fields) {
    if (isPresentationControl(field.control)) continue;
    const raw = source[field.key];
    if (field.control === "boolean") {
      result[field.key] = raw === true || raw === "true";
    } else if (field.control === "multi_select") {
      result[field.key] = Array.isArray(raw)
        ? raw.map((item) => String(item))
        : [];
    } else if (field.control === "datetime") {
      result[field.key] = rfc3339ToLocalDateTime(coerceScalar(raw));
    } else {
      result[field.key] = coerceScalar(raw);
    }
  }
  return result;
}

// applyDefaults fills empty fields with their schema default (for a brand-new submission).
export function applyDefaults(schema: FormSchema): FormValues {
  const result: FormValues = {};
  for (const field of schema.fields) {
    if (isPresentationControl(field.control)) continue;
    if (field.control === "boolean") {
      result[field.key] = field.default === "true";
    } else if (field.control === "multi_select") {
      result[field.key] = field.default
        ? field.default.split(",").map((v) => v.trim())
        : [];
    } else if (field.control === "datetime") {
      result[field.key] = rfc3339ToLocalDateTime(field.default ?? "");
    } else {
      result[field.key] = field.default ?? "";
    }
  }
  return result;
}

// formValuesToPayload serializes FormValues into the request body the server accepts. Booleans are
// sent as booleans, multi-selects as string arrays, and datetime fields as RFC 3339. Image fields
// are never sent — their value is owned by the attachment upload/remove endpoints and the server
// rejects a client-supplied image value. Empty fields are omitted.
export function formValuesToPayload(
  schema: FormSchema,
  values: FormValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (isPresentationControl(field.control)) continue;
    if (field.control === "image") continue;
    const value = values[field.key];
    if (field.control === "boolean") {
      if (value === true) payload[field.key] = true;
      continue;
    }
    if (field.control === "multi_select") {
      if (Array.isArray(value) && value.length > 0) payload[field.key] = value;
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") {
      if (field.control === "datetime") {
        const rfc = localDateTimeToRfc3339(value);
        if (rfc) payload[field.key] = rfc;
      } else {
        payload[field.key] = value;
      }
    }
  }
  return payload;
}

// validateSubmission runs the same shape checks as the server (required, type, bounds, options) so
// the submitter sees inline errors before a round trip. requireComplete gates required-field errors
// to submit/resubmit; a draft save skips them. satisfiedImages is the set of image field keys that
// have either a committed attachment or a pending (not-yet-uploaded) local file — a required image
// is complete as soon as a local image is chosen, before it is uploaded.
export function validateSubmission(
  schema: FormSchema,
  values: FormValues,
  requireComplete: boolean,
  satisfiedImages: Set<string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of schema.fields) {
    const error = fieldError(
      field,
      values[field.key],
      requireComplete,
      satisfiedImages,
    );
    if (error) errors[field.key] = error;
  }
  return errors;
}

// fieldError validates one field in isolation using exactly the rules validateSubmission applies to
// it. The editor calls this as the submitter edits so a resolved error clears immediately instead of
// lingering until the next submit attempt.
export function fieldError(
  field: FormField,
  value: FormValues[string],
  requireComplete: boolean,
  satisfiedImages: Set<string>,
): string | undefined {
  if (isPresentationControl(field.control)) return undefined;
  if (field.control === "image") {
    if (field.required && requireComplete && !satisfiedImages.has(field.key)) {
      return `${field.label} requires an image.`;
    }
    return undefined;
  }
  if (isEmpty(field, value)) {
    if (field.required && requireComplete) {
      return `${field.label} is required.`;
    }
    return undefined;
  }
  return validateField(field, value);
}

function isEmpty(field: FormField, value: FormValues[string]): boolean {
  if (field.control === "boolean") return value !== true;
  if (field.control === "multi_select")
    return !Array.isArray(value) || value.length === 0;
  return typeof value !== "string" || value.trim() === "";
}

function validateField(
  field: FormField,
  value: FormValues[string],
): string | undefined {
  const text = typeof value === "string" ? value : "";
  switch (field.control) {
    case "short_text":
    case "long_text":
      if (field.maxLength && [...text].length > field.maxLength)
        return `${field.label} must be at most ${field.maxLength} characters.`;
      if (field.minLength && [...text].length < field.minLength)
        return `${field.label} must be at least ${field.minLength} characters.`;
      return undefined;
    case "number":
    case "integer": {
      const number = Number(text);
      if (Number.isNaN(number)) return `${field.label} must be a number.`;
      if (field.control === "integer" && !Number.isInteger(number))
        return `${field.label} must be a whole number.`;
      if (field.minimum !== undefined && number < field.minimum)
        return `${field.label} must be at least ${field.minimum}.`;
      if (field.maximum !== undefined && number > field.maximum)
        return `${field.label} must be at most ${field.maximum}.`;
      return undefined;
    }
    case "url":
      try {
        const parsed = new URL(text);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          return `${field.label} must be an http(s) URL.`;
      } catch {
        return `${field.label} must be a valid URL.`;
      }
      return undefined;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
        return `${field.label} must be a date.`;
      return undefined;
    default:
      return undefined;
  }
}
