/**
 * Pure rules of the Studio feed pages: which fields take an override, how
 * an override draft becomes a request value, and what a cell shows. No
 * React here.
 */
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import type { PluginFeedField, PluginFeedRecord } from "./api";

/** The Studio route of a plugin's feed pages. */
export function feedsRoute(manifest: PluginManifestV3) {
  return `${manifest.studio!.route}/feeds`;
}

export type OverridePolicy = PluginFeedField["override"];

/** Whether an operator may override a field. */
export function overridable(field: PluginFeedField): boolean {
  return field.override !== "upstream" && !field.image;
}

/** Whether the record has an override of the field now. */
export function hasOverride(record: PluginFeedRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record.overrides, key);
}

/** A stored value as the text an input edits. */
export function draftText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

/**
 * The request value of an override draft: typed for number, integer, and
 * boolean fields. An empty draft is null, which removes the override.
 */
export function overrideValue(field: PluginFeedField, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  switch (field.control) {
    case "number":
      return Number(trimmed);
    case "integer":
      return Number.parseInt(trimmed, 10);
    case "boolean":
      return trimmed === "true";
    default:
      return text;
  }
}

/** The effective value as a short table cell. */
export function cellText(
  record: PluginFeedRecord,
  field: PluginFeedField,
): string {
  const value = record.effective[field.key] ?? "";
  if (field.image) return value === "" ? "" : "✓";
  return value.length > 60 ? `${value.slice(0, 59)}…` : value;
}
