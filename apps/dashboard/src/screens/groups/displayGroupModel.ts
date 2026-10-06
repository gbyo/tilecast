import type { Screen, ScreenGroup } from "../../api/types";
import { screenNeedsAttention } from "../fleet/fleetModel";

export type GroupDetailTab =
  "overview" | "members" | "content" | "display" | "policy";

/** The `?tab=` values stay stable even though the visible names changed. */
export const groupDetailTabs: readonly GroupDetailTab[] = [
  "overview",
  "members",
  "content",
  "display",
  "policy",
];

export function normalizeGroupDetailTab(
  requestedTab: string | null,
): GroupDetailTab {
  return groupDetailTabs.includes(requestedTab as GroupDetailTab)
    ? (requestedTab as GroupDetailTab)
    : "overview";
}

export const canManageGroups = (role?: string) =>
  role === "owner" || role === "administrator";

/** Where the tab for a group lives, for links and post-create navigation. */
export function groupPath(id: string, tab?: GroupDetailTab) {
  return tab && tab !== "overview"
    ? `/groups/${id}?tab=${tab}`
    : `/groups/${id}`;
}

export type GroupFallback = { kind: "layout" | "playlist"; name: string };

export function groupFallback(
  group: Pick<ScreenGroup, "layoutName" | "playlistName">,
): GroupFallback | null {
  if (group.layoutName) return { kind: "layout", name: group.layoutName };
  if (group.playlistName) return { kind: "playlist", name: group.playlistName };
  return null;
}

/** The value of the fallback picker for a stored assignment. */
export function savedPresentationValue(
  group: Pick<ScreenGroup, "layoutId" | "playlistId">,
) {
  if (group.layoutId) return `layout:${group.layoutId}`;
  if (group.playlistId) return `playlist:${group.playlistId}`;
  return "none";
}

export type GroupHealth = {
  total: number;
  online: number;
  attention: number;
  /** False until the screen inventory has loaded, so no health is invented. */
  known: boolean;
};

/**
 * Health of a group from the shared Fleet inventory. Classification is the
 * Fleet one: online is the computed `online` status, and attention is
 * `screenNeedsAttention`.
 */
export function groupHealth(
  group: Pick<ScreenGroup, "screens" | "membershipCount">,
  inventory: ReadonlyMap<string, Screen> | undefined,
): GroupHealth {
  const total = group.membershipCount;
  if (!inventory) return { total, online: 0, attention: 0, known: false };
  let online = 0;
  let attention = 0;
  for (const member of group.screens) {
    const screen = inventory.get(member.id);
    if (!screen) continue;
    if (screen.status === "online") online += 1;
    if (screenNeedsAttention(screen)) attention += 1;
  }
  return { total, online, attention, known: true };
}

export function screenInventory(
  screens: readonly Screen[] | undefined,
): Map<string, Screen> | undefined {
  if (!screens) return undefined;
  return new Map(screens.map((screen) => [screen.id, screen]));
}

/** Count of screens that belong to any Display Group, from the inventory. */
export function groupedScreenCount(screens: readonly Screen[] | undefined) {
  if (!screens) return undefined;
  return screens.filter((screen) => Boolean(screen.syncGroupId)).length;
}

export type PickerScreens = {
  available: Screen[];
  elsewhere: Screen[];
};

function matchesQuery(screen: Screen, query: string) {
  if (!query) return true;
  const haystack =
    `${screen.name} ${screen.location} ${screen.roomName ?? ""}`.toLowerCase();
  return haystack.includes(query);
}

/**
 * Splits the inventory for the Add screens picker. Members are omitted. A
 * screen that another group owns stays visible but cannot be selected, so
 * "where did my screen go" has an answer.
 */
export function pickerScreens(
  inventory: readonly Screen[],
  groupId: string,
  memberIds: ReadonlySet<string>,
  search: string,
): PickerScreens {
  const query = search.trim().toLowerCase();
  const available: Screen[] = [];
  const elsewhere: Screen[] = [];
  for (const screen of inventory) {
    if (memberIds.has(screen.id) || !matchesQuery(screen, query)) continue;
    if (screen.syncGroupId && screen.syncGroupId !== groupId)
      elsewhere.push(screen);
    else available.push(screen);
  }
  const byName = (a: Screen, b: Screen) => a.name.localeCompare(b.name);
  return {
    available: available.sort(byName),
    elsewhere: elsewhere.sort(byName),
  };
}

export type BatchOutcome = {
  added: string[];
  failed: { id: string; error: unknown }[];
};

/**
 * Adds screens one at a time and reports each outcome. The API has no bulk
 * membership endpoint, so a failure part-way leaves earlier additions in
 * place; the caller decides what to show instead of assuming all or nothing.
 */
export async function addScreensInBatch(
  ids: readonly string[],
  add: (id: string) => Promise<unknown>,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { added: [], failed: [] };
  for (const id of ids) {
    try {
      await add(id);
      outcome.added.push(id);
    } catch (error) {
      outcome.failed.push({ id, error });
    }
  }
  return outcome;
}
