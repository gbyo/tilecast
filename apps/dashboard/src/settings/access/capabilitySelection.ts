import type { CapabilityDefinition, CapabilityGroup } from "../../api/types";

/** The groups in the order the role editor presents them. */
export const capabilityGroupOrder: readonly CapabilityGroup[] = [
  "media",
  "widgets",
  "dataSources",
  "playlists",
  "layouts",
  "campaigns",
  "review",
  "screens",
  "schedules",
  "activity",
  "plugins",
  "administration",
];

/** The catalog grouped for display, keeping the server's order inside each. */
export function groupCatalog(
  catalog: readonly CapabilityDefinition[],
): { group: CapabilityGroup; items: CapabilityDefinition[] }[] {
  return capabilityGroupOrder
    .map((group) => ({
      group,
      items: catalog.filter((definition) => definition.group === group),
    }))
    .filter((entry) => entry.items.length > 0);
}

/**
 * Turns a capability on or off and keeps the set consistent: turning one on
 * also turns on what it requires (upload needs view), and turning one off
 * also turns off everything that requires it. The server refuses an
 * inconsistent set, so the editor never offers one.
 */
export function toggleCapability(
  catalog: readonly CapabilityDefinition[],
  selected: ReadonlySet<string>,
  key: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  const byKey = new Map(
    catalog.map((definition) => [definition.key, definition]),
  );
  if (on) {
    const add = (value: string) => {
      if (next.has(value)) return;
      next.add(value);
      byKey.get(value)?.requires.forEach(add);
    };
    add(key);
    return next;
  }
  const remove = (value: string) => {
    if (!next.has(value)) return;
    next.delete(value);
    for (const definition of catalog) {
      if (definition.requires.includes(value)) remove(definition.key);
    }
  };
  remove(key);
  return next;
}

/**
 * Whether a capability can be turned on here: it must be grantable by the
 * signed-in account, and so must everything it would pull in.
 */
export function canSelect(
  catalog: readonly CapabilityDefinition[],
  key: string,
): boolean {
  const byKey = new Map(
    catalog.map((definition) => [definition.key, definition]),
  );
  const seen = new Set<string>();
  const ok = (value: string): boolean => {
    if (seen.has(value)) return true;
    seen.add(value);
    const definition = byKey.get(value);
    return Boolean(
      definition?.grantable &&
      definition.requires.every((requirement) => ok(requirement)),
    );
  };
  return ok(key);
}

/** The capabilities of a set the editor may keep when copying a role. */
export function grantableSubset(
  catalog: readonly CapabilityDefinition[],
  capabilities: readonly string[],
): Set<string> {
  let next = new Set<string>();
  for (const key of capabilities) {
    if (canSelect(catalog, key))
      next = toggleCapability(catalog, next, key, true);
  }
  return next;
}

/** A capability key as a translation path segment. */
export function capabilityMessageKey(key: string): string {
  return key.replaceAll(".", "_");
}

/**
 * The group a capability belongs to, from its key. The role editor reads the
 * server catalog; summaries that only have a role's capability list use this.
 */
export function capabilityGroupOf(key: string): CapabilityGroup {
  const prefix = key.split(".")[0];
  switch (prefix) {
    case "media":
      return "media";
    case "widget":
      return "widgets";
    case "datasource":
      return "dataSources";
    case "playlist":
      return "playlists";
    case "layout":
      return "layouts";
    case "campaign":
      return "campaigns";
    case "content":
      return "review";
    case "screen":
      return "screens";
    case "schedule":
      return "schedules";
    case "activity":
      return "activity";
    case "plugins":
      return "plugins";
    default:
      return "administration";
  }
}
