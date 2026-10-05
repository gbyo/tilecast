import type { Screen } from "../../api/types";

/** Every facet the Filters surface edits. An empty string means "any". */
export const fleetFilterKeys = [
  "status",
  "location",
  "platform",
  "playing",
  "syncGroup",
  "orientation",
  "update",
] as const;

export type FleetFilterKey = (typeof fleetFilterKeys)[number];
export type FleetFilterValues = Record<FleetFilterKey, string>;

export const emptyFleetFilters: FleetFilterValues = {
  status: "",
  location: "",
  platform: "",
  playing: "",
  syncGroup: "",
  orientation: "",
  update: "",
};

export function activeFleetFilterCount(values: FleetFilterValues) {
  return fleetFilterKeys.filter((key) => values[key] !== "").length;
}

export const fleetStatusOptions = [
  { value: "online", labelKey: "status.online" },
  { value: "attention", labelKey: "status.attention" },
  { value: "offline", labelKey: "status.offline" },
  { value: "updating", labelKey: "status.updating" },
  { value: "syncing", labelKey: "status.syncing" },
] as const;

export const fleetPlayingOptions = [
  { value: "presentation", labelKey: "list.playingOptions.presentation" },
  { value: "playlist", labelKey: "list.playingOptions.playlist" },
  { value: "nothing", labelKey: "shared.nothingAssigned" },
] as const;

export const fleetOrientationOptions = [
  { value: "landscape", labelKey: "list.orientationOptions.landscape" },
  { value: "portrait", labelKey: "list.orientationOptions.portrait" },
] as const;

export const fleetUpdateOptions = [
  { value: "current", labelKey: "list.updateOptions.current" },
  { value: "downloading", labelKey: "list.updateOptions.downloading" },
  { value: "attention", labelKey: "status.attention" },
] as const;

export const fleetGroupOptions = [
  { value: "location", labelKey: "list.groupOptions.location" },
  { value: "status", labelKey: "list.groupOptions.status" },
  { value: "sync", labelKey: "list.groupOptions.sync" },
  { value: "none", labelKey: "list.groupOptions.none" },
] as const;

export const fleetSortOptions = [
  { value: "name-asc", labelKey: "list.sortOptions.nameAsc" },
  { value: "name-desc", labelKey: "list.sortOptions.nameDesc" },
  { value: "location-asc", labelKey: "list.sortOptions.locationAsc" },
  { value: "status-asc", labelKey: "list.sortOptions.status" },
  { value: "contact-desc", labelKey: "list.sortOptions.contactDesc" },
  { value: "contact-asc", labelKey: "list.sortOptions.contactAsc" },
  { value: "added-desc", labelKey: "list.sortOptions.addedDesc" },
  { value: "platform-asc", labelKey: "list.sortOptions.platform" },
] as const;

/** A screen needs attention when it lost contact, was disabled, or failed an update. */
export function screenNeedsAttention(screen: Screen) {
  return (
    ["stale", "offline", "disabled", "revoked"].includes(screen.status) ||
    Boolean(screen.updateError)
  );
}

export type FleetTally = {
  total: number;
  online: number;
  attention: number;
  locations: number;
};

export function tallyFleet(screens: readonly Screen[]): FleetTally {
  return {
    total: screens.length,
    online: screens.filter((screen) => screen.status === "online").length,
    attention: screens.filter(screenNeedsAttention).length,
    locations: new Set(
      screens
        .map((screen) => screen.locationId || screen.location)
        .filter(Boolean),
    ).size,
  };
}
