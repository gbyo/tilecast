// Stable field keys are referenced by Widgets and saved views, so they are generated from the
// label, validated against the server rule, and never collide with reserved synthetic keys.
import type { TFunction } from "i18next";

// Reserved keys mirror internal/forms reservedFieldKeys on the server.
export const RESERVED_FIELD_KEYS = new Set([
  "id",
  "state",
  "displayTitle",
  "priority",
  "submittedAt",
  "displayAt",
  "expiresAt",
]);

// Matches the server pattern ^[a-z][a-zA-Z0-9_]{0,63}$.
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export function slugifyKey(label: string): string {
  let key = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!key) {
    key = "field";
  }
  if (!/^[a-z]/.test(key)) {
    key = `f_${key}`;
  }
  return key.slice(0, 64);
}

// uniqueKey derives a valid, unique key from a label, avoiding existing and reserved keys.
export function uniqueKey(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = slugifyKey(label);
  let candidate = base;
  let counter = 2;
  while (RESERVED_FIELD_KEYS.has(candidate) || taken.has(candidate)) {
    // Reserve room for the suffix so it always survives the 64-char cap; truncating the whole
    // concatenation could keep producing the same (taken) base and loop forever.
    const suffix = `_${counter}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    counter += 1;
  }
  return candidate;
}

// validateKey returns a human error message, or null when the key is acceptable.
export function validateKey(
  key: string,
  existing: Iterable<string>,
  currentKey: string | undefined,
  t: TFunction<"forms", undefined>,
): string | null {
  if (!KEY_PATTERN.test(key)) {
    return t("validation.keyPattern");
  }
  if (RESERVED_FIELD_KEYS.has(key)) {
    return t("validation.keyReserved", { key });
  }
  for (const other of existing) {
    if (other !== currentKey && other === key) {
      return t("validation.keyTaken");
    }
  }
  return null;
}
