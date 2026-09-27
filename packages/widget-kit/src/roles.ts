/**
 * Semantic field roles for domain-aware Widgets
 * (docs/widgets-v2-authoring-and-first-wave.md §4).
 *
 * A generic records source may name its columns anything (`headline`,
 * `starts`, `cost`), while a domain Widget expects concepts (a title, a
 * start time, a price). Roles are the optional, small shared vocabulary
 * between the two. Roles exist only because a first-wave Widget consumes
 * them; generic List/Table/Cards keep ordinary type-compatible pickers.
 *
 * Automatic mapping, in order, when a source is connected:
 *
 * 1. match declared semantic roles;
 * 2. then match known legacy keys where required for compatibility;
 * 3. then offer compatible fields by type;
 * 4. the author may override every automatic mapping in the picker.
 *
 * There is never a provider-ID switch inside a Widget editor.
 */

/** Menu Board concepts (§4 menu roles). */
export const MENU_FIELD_ROLES = [
  "title",
  "description",
  "price",
  "category",
  "availability_start",
  "availability_end",
] as const;

/** Agenda concepts (§4 agenda roles). */
export const AGENDA_FIELD_ROLES = [
  "title",
  "start",
  "end",
  "location",
  "description",
  "category",
] as const;

/** Feed/news concepts (§5.8 suggested roles). */
export const FEED_FIELD_ROLES = [
  "headline",
  "summary",
  "published_at",
  "source_name",
  "author",
  "link",
  "image",
] as const;

export type SemanticFieldRole =
  | (typeof MENU_FIELD_ROLES)[number]
  | (typeof AGENDA_FIELD_ROLES)[number]
  | (typeof FEED_FIELD_ROLES)[number];

/** The field shape mapping needs: a key, a type, an optional role. */
export interface MappableField {
  readonly key: string;
  readonly type: string;
  readonly role?: string;
}

/** One Widget slot's mapping preference, in §4.1 priority order. */
export interface FieldSlot {
  /** Declared semantic roles, first match wins. */
  readonly roles: readonly string[];
  /** Known legacy keys (case-insensitive), first match wins. */
  readonly legacyKeys: readonly string[];
  /** Acceptable field types for the type-compatible fallback. */
  readonly types: readonly string[];
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * The key of the first field declaring `role`, or "" when no field does.
 * An empty role never matches: it means the source did not declare one.
 */
export function fieldForRole(
  fields: readonly MappableField[],
  role: string,
): string {
  if (role === "") return "";
  return fields.find((field) => field.role === role)?.key ?? "";
}

/**
 * Suggest one field key per slot following §4.1. Slots claim fields in
 * order, so two slots never share a field unless the source has nothing
 * else compatible: a title and a description pointing at the same column
 * would render the column twice and hide the real description.
 * Unmatched slots map to "" and the picker stays explicitly unmapped.
 */
export function suggestFieldMapping(
  fields: readonly MappableField[],
  slots: Readonly<Record<string, FieldSlot>>,
): Record<string, string> {
  const claimed = new Set<string>();
  const out: Record<string, string> = {};
  for (const [slotKey, slot] of Object.entries(slots)) {
    const byRole = slot.roles
      .map((role) => fieldForRole(fields, role))
      .find((key) => key !== "" && !claimed.has(key));
    if (byRole !== undefined) {
      out[slotKey] = byRole;
      claimed.add(byRole);
      continue;
    }
    const legacy = new Set(slot.legacyKeys.map(normalizeKey));
    const byLegacy = fields.find(
      (field) => legacy.has(normalizeKey(field.key)) && !claimed.has(field.key),
    )?.key;
    if (byLegacy !== undefined) {
      out[slotKey] = byLegacy;
      claimed.add(byLegacy);
      continue;
    }
    const compatible = new Set(slot.types);
    const byType = fields.find(
      (field) => compatible.has(field.type) && !claimed.has(field.key),
    )?.key;
    out[slotKey] = byType ?? "";
    if (byType !== undefined) claimed.add(byType);
  }
  return out;
}
