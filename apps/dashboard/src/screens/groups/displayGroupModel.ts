import { ApiError } from "../../api/errors";
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

/**
 * A 404 means the group is gone. The server answers this lookup with the
 * scheduling domain's `schedule_not_found` code, so the status alone decides.
 */
export function isGroupNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
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
 * How many membership adds may be in flight at once. The API has no bulk
 * endpoint and adds change a group's playback membership, so Studio adds one
 * screen at a time. Raise this only after confirming the server tolerates
 * concurrent membership writes.
 */
export const ADD_SCREENS_CONCURRENCY = 1;

/**
 * Adds screens with bounded concurrency and reports each outcome. A failure
 * never stops the remaining adds, and earlier additions stay in place, so
 * the caller can show exactly what changed instead of assuming all or
 * nothing. Outcomes are reported in input order whatever order they finish.
 */
export function addScreensInBatch(
  ids: readonly string[],
  add: (id: string) => Promise<unknown>,
  concurrency = ADD_SCREENS_CONCURRENCY,
): Promise<BatchOutcome> {
  const results: ({ ok: true } | { ok: false; error: unknown })[] = [];
  let cursor = 0;
  // Each lane starts the next screen when its current one settles. Chaining
  // keeps the lane count bounded without awaiting inside a loop.
  const lane = (): Promise<void> => {
    const index = cursor++;
    const id = ids[index];
    if (id === undefined) return Promise.resolve();
    return Promise.resolve()
      .then(() => add(id))
      .then(
        () => {
          results[index] = { ok: true };
        },
        (error: unknown) => {
          results[index] = { ok: false, error };
        },
      )
      .then(lane);
  };
  const lanes = Math.max(1, Math.min(concurrency, ids.length));
  return Promise.all(Array.from({ length: lanes }, lane)).then(() => {
    const outcome: BatchOutcome = { added: [], failed: [] };
    ids.forEach((id, index) => {
      const result = results[index];
      if (result?.ok) outcome.added.push(id);
      else outcome.failed.push({ id, error: result?.error });
    });
    return outcome;
  });
}
