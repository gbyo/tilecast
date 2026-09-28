/**
 * Upgrade a saved Widget configuration to its provider's current
 * authoring schema (docs/widgets-v2-catalog.md §8).
 *
 * A migrated provider keeps its persisted rows. Its component
 * `configTemplate` already says how each legacy key maps: a node
 * `{"$config": key, "default": {"$config": legacyKey}}` prefers the
 * current key and falls back to the key it supersedes. That template is
 * the one source of the mapping, so no second upgrade table exists:
 *
 * 1. A schema key missing from the saved row is filled from the default
 *    of its template node when that default reads a key the row has.
 * 2. A legacy key that only such defaults read is consumed: the upgraded
 *    row no longer carries it.
 * 3. Keys the template reads elsewhere stay, because the component still
 *    reads them (for example a Table's legacy `fields`).
 *
 * The Server applies the same rules before it validates a write
 * (contentdefs.UpgradeAuthorConfiguration). Studio applies them when the
 * editor opens a saved Widget, so the inspector shows the upgraded values.
 *
 * This module is a separate entry (`@tilecast/widget-sdk/upgrade`): it
 * reaches the manifest compiler, whose schema library must never load in
 * the Player Runtime under its CSP.
 */
import { compileComponentConfig } from "./manifest.ts";

export interface UpgradeField {
  readonly key: string;
  readonly control?: string;
  readonly maximumItems?: number;
  readonly itemFields?: readonly UpgradeField[];
}

/**
 * Keep only the declared item keys of a repeating group, within its item
 * bound. A saved row from an older release may carry item keys a
 * redesigned Widget no longer offers (for example a Table column format).
 */
function pruneItems(field: UpgradeField, value: unknown): unknown {
  if (field.control !== "repeating_group" || !Array.isArray(value)) {
    return value;
  }
  const keys = new Set((field.itemFields ?? []).map((item) => item.key));
  const bounded =
    typeof field.maximumItems === "number"
      ? value.slice(0, field.maximumItems)
      : value;
  return bounded.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item)) {
      if (keys.has(key)) out[key] = entry;
    }
    return out;
  });
}

interface TemplateReference {
  readonly key: string;
  readonly fallback: unknown;
  readonly hasFallback: boolean;
}

function isReference(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["$config"] === "string"
  );
}

/** Every configuration key a template value reads, with repeats. */
function collectReads(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReads(item, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (isReference(node)) {
    into.push(node["$config"] as string);
    if (typeof node["when"] === "string" && node["when"] !== "") {
      into.push(node["when"]);
    }
    if (Object.hasOwn(node, "default")) collectReads(node["default"], into);
    return;
  }
  for (const item of Object.values(node)) collectReads(item, into);
}

/**
 * The first template node that maps each configuration key, visiting
 * object members in sorted key order so the Go mirror finds the same node.
 */
function referencesByKey(template: unknown): Map<string, TemplateReference> {
  const found = new Map<string, TemplateReference>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (isReference(node)) {
      const key = node["$config"] as string;
      if (!found.has(key)) {
        found.set(key, {
          key,
          fallback: node["default"],
          hasFallback: Object.hasOwn(node, "default"),
        });
      }
      if (Object.hasOwn(node, "default")) visit(node["default"]);
      return;
    }
    for (const key of Object.keys(node).sort()) visit(node[key]);
  };
  visit(template);
  return found;
}

/** Every configuration key a template reads. */
export function templateReads(template: unknown): Set<string> {
  const reads: string[] = [];
  collectReads(template, reads);
  return new Set(reads);
}

export interface AuthorUpgrade {
  /** The upgraded configuration. */
  readonly configuration: Record<string, unknown>;
  /** Schema keys filled from legacy keys, in schema order. */
  readonly filled: readonly string[];
  /** Legacy keys the upgrade consumed. */
  readonly consumed: readonly string[];
}

/**
 * Apply rules 1 and 2. With `dropUnknown`, also remove keys that are
 * neither schema fields nor read by the template: an editor saves only
 * what the provider still accepts.
 */
export function upgradeAuthorConfiguration(
  fields: readonly UpgradeField[],
  configTemplate: Readonly<Record<string, unknown>>,
  configuration: Readonly<Record<string, unknown>>,
  options: { dropUnknown?: boolean } = {},
): AuthorUpgrade {
  const schema = new Set(fields.map((field) => field.key));
  const references = referencesByKey(configTemplate);
  const out: Record<string, unknown> = { ...configuration };
  const filled: string[] = [];
  const fallbackReads: string[] = [];
  for (const field of fields) {
    if (Object.hasOwn(out, field.key)) continue;
    const reference = references.get(field.key);
    if (!reference?.hasFallback) continue;
    const reads: string[] = [];
    collectReads(reference.fallback, reads);
    // Only a fallback that reads a saved legacy key upgrades anything; a
    // literal default is the schema default's job.
    if (!reads.some((key) => !schema.has(key) && Object.hasOwn(out, key))) {
      continue;
    }
    let value: unknown;
    try {
      value = compileComponentConfig({ value: reference.fallback }, out)[
        "value"
      ];
    } catch {
      continue;
    }
    if (value === undefined) continue;
    out[field.key] = value;
    filled.push(field.key);
    fallbackReads.push(...reads);
  }
  // A legacy key is consumed only when every template read of it was a
  // fallback the upgrade just resolved; otherwise the component still
  // reads it directly and it must stay.
  const allReads: string[] = [];
  collectReads(configTemplate, allReads);
  const count = (list: readonly string[], key: string) =>
    list.filter((item) => item === key).length;
  const consumed: string[] = [];
  for (const key of new Set(fallbackReads)) {
    if (schema.has(key) || !Object.hasOwn(out, key)) continue;
    if (count(fallbackReads, key) === count(allReads, key)) {
      delete out[key];
      consumed.push(key);
    }
  }
  if (options.dropUnknown) {
    const reads = new Set(allReads);
    for (const key of Object.keys(out)) {
      if (!schema.has(key) && !reads.has(key)) delete out[key];
    }
    for (const field of fields) {
      if (Object.hasOwn(out, field.key)) {
        out[field.key] = pruneItems(field, out[field.key]);
      }
    }
  }
  return { configuration: out, filled, consumed };
}
