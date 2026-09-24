import type { TFunction } from "i18next";
import type { FormField, FormSchema } from "../api/types";
import type { FormValues } from "./FormRenderer";
import { isPresentationControl } from "./formSchema";

type FormsT = TFunction<"forms", undefined>;

// coerceScalar turns an unknown stored value into the string the renderer edits. Strings, numbers,
// and booleans stringify directly; anything else (objects/arrays for a scalar field) becomes empty.
export function coerceScalar(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

// rfc3339ToLocalDateTime converts a stored RFC 3339 timestamp into the value a native
// datetime-local input expects (YYYY-MM-DDTHH:mm in the viewer's local time). Empty/invalid input
// returns "".
export function rfc3339ToLocalDateTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

// localDateTimeToRfc3339 converts a datetime-local input value (interpreted in the viewer's local
// time) into the RFC 3339 timestamp the server requires. Empty/invalid input returns "".
export function localDateTimeToRfc3339(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
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
  t: FormsT,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of schema.fields) {
    const error = fieldError(
      field,
      values[field.key],
      requireComplete,
      satisfiedImages,
      t,
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
  t: FormsT,
): string | undefined {
  if (isPresentationControl(field.control)) return undefined;
  if (field.control === "image") {
    if (field.required && requireComplete && !satisfiedImages.has(field.key)) {
      return t("validation.imageRequired", { label: field.label });
    }
    return undefined;
  }
  if (isEmpty(field, value)) {
    if (field.required && requireComplete) {
      return t("validation.required", { label: field.label });
    }
    return undefined;
  }
  return validateField(field, value, t);
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
  t: FormsT,
): string | undefined {
  const text = typeof value === "string" ? value : "";
  switch (field.control) {
    case "short_text":
    case "long_text":
      if (field.maxLength && [...text].length > field.maxLength)
        return t("validation.maxLength", {
          label: field.label,
          max: field.maxLength,
        });
      if (field.minLength && [...text].length < field.minLength)
        return t("validation.minLength", {
          label: field.label,
          min: field.minLength,
        });
      return undefined;
    case "number":
    case "integer": {
      const number = Number(text);
      if (Number.isNaN(number))
        return t("validation.notNumber", { label: field.label });
      if (field.control === "integer" && !Number.isInteger(number))
        return t("validation.notInteger", { label: field.label });
      if (field.minimum !== undefined && number < field.minimum)
        return t("validation.minValue", {
          label: field.label,
          minimum: field.minimum,
        });
      if (field.maximum !== undefined && number > field.maximum)
        return t("validation.maxValue", {
          label: field.label,
          maximum: field.maximum,
        });
      return undefined;
    }
    case "url":
      try {
        const parsed = new URL(text);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          return t("validation.urlProtocol", { label: field.label });
      } catch {
        return t("validation.urlInvalid", { label: field.label });
      }
      return undefined;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
        return t("validation.dateInvalid", { label: field.label });
      return undefined;
    default:
      return undefined;
  }
}
